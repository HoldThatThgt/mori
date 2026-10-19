// 从真实会话录制界面测试用的 fixture（tests/fixtures/m1/*.json）。
// 直接通过 window.mori（与界面相同的进程桥）发命令，记录命令、命令结果和后台进程转发的全部事件及其时间。
// 每次 turn_end 后像界面一样读取一次 session.state，供回放时回答上下文用量。
// M2 起新会话默认"每次询问"，命令和编辑要等批准：每个场景 session.create 之后直接用 window.mori 把会话切到
// "全部允许"（不经录制器，所以录下的命令序列仍是 M1 的）；录下的事件里会多出 gate 为 all 的 mori.tool_gate。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m1-record.mjs --source <走查数据目录> [--only name1,name2] [--exe <Mori.exe>]
// 走查数据目录是负责人在 Mori 里填过连接的目录（key 由 Mori 加密保存）；脚本只复制密文文件，不读取 key。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRoot, arg, launch, oneLine, prepareProject, scratchUserData } from './lib.mjs';

const source = arg('source');
const exePath = arg('exe');
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const outDir = join(appRoot, 'tests/fixtures/m1');

/** @brief 页面里的录制器：记录命令、结果和事件；提供等待事件的工具。 */
function installRecorder() {
  const rec = {
    t0: performance.now(),
    steps: [],
    reset() { this.t0 = performance.now(); this.steps = []; },
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
    async waitFor(predicate, timeout = 180000) {
      const deadline = Date.now() + timeout;
      while (!this.events().some(predicate)) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for an event');
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    settled(sessionId) { return this.waitFor((e) => e.sessionId === sessionId && e.event.type === 'agent_settled'); },
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

/** @brief 一个录制场景：在页面里执行 body，等它结束，写出 fixture。 */
async function runScenario(page, scenario, context) {
  const steps = await page.evaluate(async ({ body, args }) => {
    const rec = window.__rec;
    rec.reset();
    // eslint-disable-next-line no-new-func
    try {
      await new Function('rec', 'args', `return (${body})(rec, args);`)(rec, args);
    } catch (error) {
      const seen = rec.steps.map((s) => s.command?.type ?? s.result?.type ?? s.envelope?.event.type);
      const last = JSON.stringify(rec.steps.at(-1)).slice(0, 600);
      throw new Error(`${error.message}; steps: ${seen.join(' ')}; last: ${last}`);
    }
    await rec.sleep(300);
    return rec.steps;
  }, { body: scenario.body.toString(), args: context });
  const fixture = {
    source: 'real',
    note: 'Recorded from a real session by tests/ui/m1-record.mjs; do not edit by hand.',
    name: scenario.name,
    description: scenario.description,
    endpoint: context.endpoint,
    model: context.model,
    recordedAt: new Date().toISOString(),
    steps,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${scenario.name}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
  const types = steps.filter((s) => s.envelope).map((s) => s.envelope.event.type);
  const tools = steps.filter((s) => s.envelope?.event.type === 'tool_execution_end')
    .map((s) => `${s.envelope.event.toolName}${s.envelope.event.isError ? '(error)' : ''}`);
  console.log(`RECORDED ${scenario.name}: ${steps.length} steps, ${types.length} events, tools: ${tools.join(', ')}`);
}

/** @brief 新建会话并切到"全部允许"；切换不经录制器，fixture 里没有这条命令。 */
const create = async (rec, args) => {
  const s = await rec.cmd({ type: 'session.create', cwd: args.cwd });
  await window.mori.request({ type: 'approval.setMode', sessionId: s.sessionId, mode: 'all' });
  return s;
};
const say = (rec, s, text, behavior) => rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text, behavior });

/** @brief 用正常连接录制的场景（同一个数据目录）。 */
const scenarios = [
  { name: 'readme', description: '总结 README：思考、读取工具、Markdown 回复',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '总结一下 README.md');
      await rec.settled(s.sessionId);
    } },
  { name: 'markdown', description: '只有 Markdown 的回复：标题、列表、表格、代码块',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '不要调用任何工具。用 Markdown 回复：一个二级标题、一个三项列表、一个两列表格、' +
        '一段 TypeScript 代码块，内容是介绍 add 函数。');
      await rec.settled(s.sessionId);
    } },
  { name: 'command-fail', description: '失败的命令：退出码非零',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '运行命令 `ls does-not-exist-dir`，然后用一句话告诉我结果。');
      await rec.settled(s.sessionId);
    } },
  { name: 'edit', description: '编辑文件：edit 工具带 diff',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '把 README.md 第一行的标题改成 `# Mori fixture project (edited)`，只改这一行。');
      await rec.settled(s.sessionId);
    } },
  { name: 'queue-steer', description: '命令运行中先插话、再排队；结束后用会话文件重新打开',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '运行命令 `sleep 8; echo done`，完成后告诉我输出。');
      await rec.waitFor((e) => e.event.type === 'tool_execution_start');
      await rec.sleep(1500);
      await args.say(rec, s, '插话：另外告诉我 README.md 有几行。', 'steer');
      await args.say(rec, s, '排队：最后用一句话总结你做了什么。', 'followUp');
      await rec.settled(s.sessionId);
      await rec.cmd({ type: 'session.open', sessionFile: s.sessionFile });
    } },
  { name: 'two-tools-steer', description: '一条回复里两个工具调用，第一个开始前插话：确认插话不跳过剩下的调用',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '请在同一条回复里同时调用两次 bash：第一次运行 `sleep 3; echo first`，' +
        '第二次运行 `echo second`。两个都完成后告诉我结果。');
      await rec.waitFor((e) => e.event.type === 'message_update' && e.event.update.type === 'toolcall_start');
      await args.say(rec, s, '插话：结果用英文写。', 'steer');
      await rec.settled(s.sessionId);
    } },
  { name: 'stop', description: '命令运行中排队一条，然后按停止：先撤回排队，再停止；结束后用会话文件重新打开',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '运行命令 `sleep 30; echo late`，然后告诉我输出。');
      await rec.waitFor((e) => e.event.type === 'tool_execution_start');
      await rec.sleep(2000);
      await args.say(rec, s, '排队：这条会被撤回', 'followUp');
      await rec.waitFor((e) => e.event.type === 'queue_update' && e.event.followUp.length === 1);
      await rec.cmd({ type: 'session.clearQueue', sessionId: s.sessionId });
      await rec.cmd({ type: 'session.abort', sessionId: s.sessionId });
      await rec.settled(s.sessionId);
      await rec.cmd({ type: 'session.open', sessionFile: s.sessionFile });
    } },
];

/** @brief 启动 Mori、装好录制器，依次跑给定场景。 */
async function recordWith(userData, list, context) {
  const app = await launch({ exePath, userData });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.mori));
    await page.evaluate(installRecorder);
    for (const scenario of list) {
      if (only && !only.includes(scenario.name)) continue;
      await runScenario(page, { ...scenario, body: wrap(scenario.body) }, context);
    }
  } finally {
    await app.close().catch(() => {});
  }
}

/** @brief 把共用的 create / say 注入场景函数（页面里没有模块作用域）。 */
function wrap(body) {
  return `async (rec, args) => {
    args.create = ${create.toString()};
    args.say = ${say.toString()};
    return (${body.toString()})(rec, args);
  }`;
}

/** @brief 读取走查连接的非机密信息。 */
function connectionInfo(dir) {
  const provider = JSON.parse(readFileSync(join(dir, 'pi', 'models.json'), 'utf8')).providers['mori-endpoint'];
  return { endpoint: provider.baseUrl, model: `mori-endpoint/${provider.models[0].id}` };
}

/**
 * @brief 录制压缩场景：models.json 的上下文长度改为 8000，pi settings.json 的压缩参数调小。
 *        pi 默认 keepRecentTokens 为 20000，8k 上下文下没有可压缩的旧内容，永远不会压缩（见 m1-checks.md）。
 */
function setSmallContext(dir) {
  const modelsPath = join(dir, 'pi', 'models.json');
  const models = JSON.parse(readFileSync(modelsPath, 'utf8'));
  models.providers['mori-endpoint'].models[0].contextWindow = 8000;
  writeFileSync(modelsPath, JSON.stringify(models, null, 2));
  const settingsPath = join(dir, 'pi', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.compaction = { reserveTokens: 6000, keepRecentTokens: 300 };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

const errorScenarios = {
  noKey: { name: 'no-key', description: '没有保存 key：发送时就失败',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '你好');
      await rec.waitFor((e) => e.event.type === 'mori.prompt_error');
    } },
  wrongKey: { name: 'wrong-key', description: 'key 填错：模型回复 401',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      await args.say(rec, s, '你好');
      await rec.settled(s.sessionId);
    } },
  compaction: { name: 'compaction',
    description: '上下文长度 8000、pi 压缩参数 reserveTokens 6000 / keepRecentTokens 300：长聊直到压缩；结束后重新打开',
    body: async (rec, args) => {
      const s = await args.create(rec, args);
      const asks = ['读一下 README.md 和 src/a.ts，然后详细介绍这个项目。',
        '再详细解释 add 函数，并给出三个使用例子。', '把上面的内容整理成一份 Markdown 文档的大纲。',
        '最后用三句话总结我们聊了什么。'];
      const settledCount = () => rec.events().filter((e) => e.event.type === 'agent_settled').length;
      for (const text of asks) {
        const before = settledCount();
        await args.say(rec, s, text);
        await rec.waitFor(() => settledCount() > before);
      }
      await rec.cmd({ type: 'session.open', sessionFile: s.sessionFile });
    } },
};

const { project, root } = prepareProject('mori-m1-record-');
const context = { cwd: project, ...connectionInfo(source) };
const made = [];
try {
  made.push(scratchUserData(source));
  await recordWith(made[0], scenarios, context);

  if (!only || only.includes('compaction')) {
    made.push(scratchUserData(source));
    setSmallContext(made[made.length - 1]);
    await recordWith(made[made.length - 1], [errorScenarios.compaction], context);
  }
  if (!only || only.includes('no-key')) {
    made.push(scratchUserData(source, { withKey: false }));
    await recordWith(made[made.length - 1], [errorScenarios.noKey], context);
  }
  if (!only || only.includes('wrong-key')) await recordWrongKey(context);
} catch (error) {
  console.error(`FAIL recording: ${oneLine(error, 400)}`);
  process.exitCode = 1;
} finally {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

/** @brief key 填错：在全新的数据目录里用一个明显错误的 key 保存同一端点，再发消息。 */
async function recordWrongKey(ctx) {
  const dir = scratchUserData(source, { withKey: false });
  made.push(dir);
  const app = await launch({ exePath, userData: dir });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.mori));
    const saved = JSON.parse(readFileSync(join(dir, 'pi', 'models.json'), 'utf8')).providers['mori-endpoint'];
    // 这是故意填错的 key，不是机密。
    const connection = { name: 'wrong key', baseUrl: saved.baseUrl, api: 'openai-completions',
      apiKey: 'sk-mori-fixture-wrong-key', modelId: saved.models[0].id, contextWindow: 128000, compat: [] };
    await page.evaluate((c) => window.mori.request({ type: 'connection.save', connection: c }), connection);
    await page.evaluate(installRecorder);
    await runScenario(page, { ...errorScenarios.wrongKey, body: wrap(errorScenarios.wrongKey.body) }, ctx);
  } finally {
    await app.close().catch(() => {});
  }
}
