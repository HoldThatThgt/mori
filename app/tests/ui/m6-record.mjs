// 从真实会话录制 M6（设置与工具页）界面测试用的 fixture（tests/fixtures/m6/*.json）。做法与 m5-record.mjs 相同：
// 直接通过 window.mori（与界面相同的进程桥）发命令，记录命令、结果和后台进程转发的全部事件及其时间；批准请求由页面里的
// 录制器答复。每个场景用新的临时数据目录和一次新的启动。M6 多录的：config.get、tools.get、agents.get、session.commands
// （回放桥把它们当只读查询，按录制回答界面），以及设置页、输入框下面一行（2026-10-21 起范围、Effort、权限按钮在这里，
// 原来在顶栏）、工具页发出的写入命令（回放时界面发出的要与录制一致）。
// 录完先核对场景要的东西真的发生了；不符合时不写进 fixtures，写到 test-results/m6-record/<名字>.rejected.json。
// 用法（在 app/ 下，先 npm run build）：
//   node tests/ui/m6-record.mjs --source <走查数据目录> [--only name1,name2] [--exe <Mori.exe>]
// 走查数据目录是负责人在 Mori（v1）里保存过提供商的目录（key 由 Mori 加密保存）；脚本只复制密文文件，不读取 key。
// v1（docs/specs/model-providers.md §14.1、§14.4）：提供商从 model-config.json 取（lib.mjs realProviders）；每个场景的临时
// 项目先在复制出的配置里授权公网、默认范围设为测试分组 [DeepSeek, GLM]（lib.mjs allowRealProject，测试准备）。
// 范围（model-range：在 Models 里加模型、在输入框下面一行的范围菜单里选）与思考强度（thinking）两个场景写到 tests/fixtures/v1/；
// v0 的 model-switch 场景删去（v1 没有 model.save、session.setModel）。
// MCP 场景用 tests/mcp-server/server.mjs（synthetic，本地 stdio 服务），插件场景用 tests/pi-package（synthetic 包）的副本。

import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allowRealProject, appRoot, arg, launch, oneLine, prepareProject, REAL_GROUP, realProviders, scratchUserData,
} from './lib.mjs';

const source = arg('source');
const exePath = arg('exe');
const only = arg('only')?.split(',');
if (!source) throw new Error('Missing --source <user data dir with a saved connection>');
const outDir = join(appRoot, 'tests/fixtures/m6');
/** v1 的场景（范围、思考强度）写到这里 */
const v1Dir = join(appRoot, 'tests/fixtures/v1');
const rejectedDir = join(appRoot, 'test-results/m6-record');
const mcpServer = join(appRoot, 'tests', 'mcp-server', 'server.mjs');

/** 场景里发的文字和用到的值 */
const prompts = {
  ONE_LINE: '用一句话介绍你自己。不要调用任何工具。',
  ONE_LINE_2: '用一句话说说今天适合做什么。不要调用任何工具。',
  SECOND_MODEL: 'deepseek-v4-pro',
  /** 等新加的模型探针跑完（models.get 的档案），最多这么久 */
  PROBE_WAIT_MS: 300000,
  CONTEXT: 1000000,
  REASON_1: '笼子里有鸡和兔共 35 只，脚共 94 只。鸡兔各几只？只给出答案，不要调用任何工具。',
  REASON_2: '一个数加上它的一半等于 45，这个数是多少？只给出答案，不要调用任何工具。',
  AGENTS: '每次回答都以“收到”两个字开头。\n',
  SKILLS_Q: '你现在能用哪些技能（skills）？只列出技能名，不要调用任何工具。',
  PROJECT_SKILL: 'm6-proj-skill',
  MCP_CALL: '请调用 mcp__mori_test__echo 工具，参数 text 为 hello-mori，然后用一句话告诉我它返回了什么。',
  PACKAGE_CALL: '请调用 package_hello 工具（不需要参数），然后用一句话告诉我它返回了什么。',
  SLASH_SKILL: '/skill:m6-hello',
  SLASH_TEMPLATE: '/m6-summary README.md',
};

/** @brief 写一个技能文件夹。 */
function writeSkill(dir, name, description, body) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

/** @brief 页面里的录制器（与 m5-record.mjs 相同）。 */
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
      while (!(await fn())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await this.sleep(100);
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

/** @brief 像界面一样新建会话：先 trust.check；要问时带上 trust（录制时代你回答）。 */
const create = async (rec, cwd, trust) => {
  const check = await rec.cmd({ type: 'trust.check', cwd });
  return rec.cmd({ type: 'session.create', cwd, ...(check.ask || trust ? { trust: trust ?? undefined } : {}) });
};
const list = (rec) => rec.cmd({ type: 'session.list' });
const config = (rec) => rec.cmd({ type: 'config.get' });
/** @brief 发一条消息，等它的这一轮结束。 */
const say = async (rec, s, text, allow = []) => {
  const before = rec.count(s.sessionId, 'agent_settled');
  await rec.cmd({ type: 'session.prompt', sessionId: s.sessionId, text });
  await rec.settle({ [s.sessionId]: before + 1 }, allow);
};
/** @brief 读工具页，直到 fn(结果) 为真（MCP 服务在会话打开后才在后台连上）。 */
const toolsUntil = async (rec, sessionId, fn, what) => {
  let info = null;
  await rec.until(async () => {
    info = await rec.cmd({ type: 'tools.get', ...(sessionId ? { sessionId } : {}) });
    return fn(info);
  }, what, 30000);
  return info;
};

// ---------- 录完后的核对（在 node 里） ----------

const need = (ok, problem) => (ok ? [] : [problem]);
const values = (steps, type) => steps.filter((s) => s.result?.type === type && !s.result.error)
  .map((s) => s.result.value);
const failures = (steps) => steps.filter((s) => s.result?.error).map((s) => `${s.result.type}: ${s.result.error}`);
const eventsOf = (steps, type) => steps.filter((s) => s.envelope?.event.type === type).map((s) => s.envelope);
/** @brief 一个会话的助手回复（message_end），按顺序。 */
const replies = (steps, sessionId) => eventsOf(steps, 'message_end')
  .filter((e) => e.sessionId === sessionId && e.event.message.role === 'assistant').map((e) => e.event.message);
const textOf = (message) => (message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
const thinkingOf = (message) => (message?.content ?? []).filter((c) => c.type === 'thinking')
  .map((c) => c.thinking).join('');
/** @brief 一个会话最后一条有正文的回复。 */
const lastText = (steps, sessionId) => textOf(replies(steps, sessionId).filter((m) => textOf(m)).at(-1));

/** @brief 共同的要求：开头是会话列表；没有失败的命令（allowFail 里的除外）。 */
function common(steps, allowFail = []) {
  const first = steps.find((s) => s.command)?.command;
  const failed = failures(steps).filter((text) => !allowFail.some((type) => text.startsWith(type)));
  return [...need(first?.type === 'session.list', 'the recording does not start with session.list'),
    ...need(failed.length === 0, `failed commands: ${failed.join('; ')}`)];
}

// ---------- 场景 ----------

/**
 * @brief model-range（v1，范围）：在 Models 里给首选提供商加第二个模型（models.saveModel），等它的探针跑完；新会话
 *        （默认范围是测试分组）先由分组的第一个候选回答，在输入框下面一行选新加的模型（session.setPick）后再回答一句。
 */
const modelRange = { name: 'model-range', dir: v1Dir, description: '在 Models 里给首选提供商加模型 deepseek-v4-pro；'
    + '新会话（范围是测试分组）先由首选的第一个模型回答一句，在输入框下面一行的范围菜单里选 deepseek-v4-pro 后再回答一句',
  phases: [{ page: async (rec, args) => {
    await args.list(rec);
    await args.config(rec);
    const before = await rec.cmd({ type: 'models.get' });
    const provider = before.config.providers.find((item) => item.id === args.provider);
    const base = provider.models[0];
    await rec.cmd({ type: 'models.saveModel', providerId: args.provider, adding: true,
      model: { ...base, id: args.SECOND_MODEL, family: '', reasoning: false } });
    const ref = `${args.provider}/${args.SECOND_MODEL}`;
    // 每 3 秒读一次档案（每次读都录下来，回放时界面读到的是最后一次）
    await rec.until(async () => {
      await rec.sleep(3000);
      return (await rec.cmd({ type: 'models.get' })).profiles[ref]?.tool_calling.state === 'verified';
    }, `probes of ${ref}`, args.PROBE_WAIT_MS);
    const s = await args.create(rec, args.cwd);
    await rec.cmd({ type: 'session.pickOptions', sessionId: s.sessionId });
    await args.say(rec, s, args.ONE_LINE);
    await rec.cmd({ type: 'session.setPick', sessionId: s.sessionId, pick: ref });
    await rec.cmd({ type: 'session.pickOptions', sessionId: s.sessionId });
    await args.say(rec, s, args.ONE_LINE_2);
  } }],
  check: (steps, args) => {
    const s = values(steps, 'session.create')[0];
    const models = replies(steps, s?.sessionId).filter((m) => textOf(m)).map((m) => `${m.provider}/${m.model}`);
    const picked = values(steps, 'session.setPick')[0];
    return [...common(steps), ...need(s?.pick === args.group, `new session range ${s?.pick}`),
      ...need(models[0] === args.first && models.at(-1) === `${args.provider}/${args.SECOND_MODEL}`,
        `reply models ${models}`), ...need(picked?.pick === `${args.provider}/${args.SECOND_MODEL}`, 'setPick result')];
  } };

/**
 * @brief thinking（v1）：在 Models 里把首选的模型标为支持思考（新会话默认"Medium"）；新会话里输入框下面一行切到"High"有思考内容，
 *        切到"Off"没有。保存之后不再录 models.get：回放时界面保存后读到的仍是保存前的配置（回放桥直接应答写命令）。
 */
const thinking = { name: 'thinking', dir: v1Dir, description: '在 Models 里把首选的第一个模型标为支持思考（新会话默认'
    + '"中"）；新会话里输入框下面一行切到"高"，问一道要推理的题，回复带思考内容；切到"关"再问一道，回复没有思考内容',
  phases: [{ page: async (rec, args) => {
    await args.list(rec);
    await args.config(rec);
    const before = await rec.cmd({ type: 'models.get' });
    const base = before.config.providers.find((item) => item.id === args.provider).models[0];
    await rec.cmd({ type: 'models.saveModel', providerId: args.provider, adding: false,
      model: { ...base, reasoning: true }, thinkingLevel: 'medium' });
    const s = await args.create(rec, args.cwd);
    await rec.cmd({ type: 'session.setThinking', sessionId: s.sessionId, level: 'high' });
    await args.say(rec, s, args.REASON_1);
    await rec.cmd({ type: 'session.setThinking', sessionId: s.sessionId, level: 'off' });
    await args.say(rec, s, args.REASON_2);
  } }],
  check: (steps) => {
    const s = values(steps, 'session.create')[0];
    const [first, second] = replies(steps, s?.sessionId).filter((m) => textOf(m));
    return [...common(steps), ...need(s?.reasoning === true && s?.thinkingLevel === 'medium', 'new session at medium'),
      ...need(thinkingOf(first).length > 0, 'thinking at high'), ...need(second && !thinkingOf(second), 'no thinking at off')];
  } };

/** @brief agents-md：用户级 AGENTS.md 写"每次回答以'收到'开头"，新会话的第一条回复照做。 */
const agentsMd = { name: 'agents-md', description: '在用户级 AGENTS.md 写"每次回答都以“收到”两个字开头"并保存；'
    + '新会话的第一条回复以"收到"开头；设置页读到生效的文件',
  phases: [{ page: async (rec, args) => {
    await args.list(rec);
    await rec.cmd({ type: 'agents.get' });
    await rec.cmd({ type: 'agents.save', content: args.AGENTS });
    await rec.cmd({ type: 'agents.get' });
    const s = await args.create(rec, args.cwd);
    await rec.cmd({ type: 'agents.get', sessionId: s.sessionId });
    await args.say(rec, s, args.ONE_LINE);
  } }],
  check: (steps) => {
    const s = values(steps, 'session.create')[0];
    const after = values(steps, 'agents.get')[1];
    return [...common(steps), ...need(lastText(steps, s?.sessionId).trim().startsWith('收到'),
      `reply: ${lastText(steps, s?.sessionId).slice(0, 40)}`),
    ...need(after?.effectivePath?.endsWith('AGENTS.md') && after?.content === '每次回答都以“收到”两个字开头。\n',
      'effective file')];
  } };

/** @brief project-skill：信任的项目里的 .pi/skills 技能；停用后新会话没有它。 */
const projectSkill = { name: 'project-skill', description: '项目 .pi/skills 里放技能 m6-proj-skill，信任后打开：工具页列出它（本项目），'
    + '模型能说出它；停用后（写项目的 .pi/settings.json，与 pi config -l 相同）新会话的"/"补全和模型的回答里都没有它',
  phases: [{ node: (steps, args) => {
    writeSkill(join(args.cwd, '.pi', 'skills', args.PROJECT_SKILL), args.PROJECT_SKILL,
      'Synthetic project skill for the Mori M6 walkthrough. Use it when asked about M6 project checks.',
      '# m6-proj-skill\n\nReply with M6-PROJECT-SKILL-OK.');
  } }, { page: async (rec, args) => {
    await args.list(rec);
    const trust = { trusted: true, remember: false };
    const a = await args.create(rec, args.cwd, trust);
    const before = await rec.cmd({ type: 'tools.get', sessionId: a.sessionId });
    await args.say(rec, a, args.SKILLS_Q);
    const skill = before.skills.find((item) => item.name === args.PROJECT_SKILL);
    await rec.cmd({ type: 'resource.toggle', sessionId: a.sessionId, kind: 'skills', path: skill.path, enabled: false });
    await rec.cmd({ type: 'tools.get', sessionId: a.sessionId });
    const b = await args.create(rec, args.cwd, trust);
    await rec.cmd({ type: 'session.commands', sessionId: b.sessionId });
    await args.say(rec, b, args.SKILLS_Q);
  } }],
  check: (steps) => {
    const [a, b] = values(steps, 'session.create');
    const [before, after] = values(steps, 'tools.get');
    const skill = (info) => info?.skills.find((item) => item.name === 'm6-proj-skill');
    const commands = values(steps, 'session.commands')[0] ?? [];
    return [...common(steps), ...need(skill(before)?.scope === 'project' && skill(before)?.enabled, 'listed as project'),
      ...need(skill(after) && !skill(after).enabled, 'disabled after toggle'),
      ...need(lastText(steps, a?.sessionId).includes('m6-proj-skill'), 'first session knows the skill'),
      ...need(!lastText(steps, b?.sessionId).includes('m6-proj-skill'), 'second session does not'),
      ...need(!commands.some((c) => c.name === 'skill:m6-proj-skill'), 'no slash command')];
  } };

/** @brief mcp：表单添加 stdio 服务，新会话看到它的工具，调用时出批准卡；命令写错的服务给出 pi 的错误原文。 */
const mcp = { name: 'mcp', description: '在用户级 mcp.json 添加合成 MCP 服务 mori-test（直接调用）、命令写错的 mori-broken、'
    + '不注册工具的 mori-empty；新会话的工具页看到 mori-test 的工具名，调用 mcp__mori_test__echo 出批准卡、允许后返回；'
    + 'pi 的通知给出 mori-broken 的错误原文',
  phases: [{ page: async (rec, args) => {
    await args.list(rec);
    await rec.cmd({ type: 'mcp.save', name: 'mori-test', previousName: null,
      entry: { command: 'node', args: [args.mcpServer], exposure: 'direct' } });
    await rec.cmd({ type: 'mcp.save', name: 'mori-broken', previousName: null,
      entry: { command: 'no-such-command-mori', args: [], exposure: 'direct' } });
    await rec.cmd({ type: 'mcp.save', name: 'mori-empty', previousName: null,
      entry: { command: 'node', args: [args.mcpServer], env: { MORI_MCP_TOOLS: 'none' }, exposure: 'direct' } });
    const s = await args.create(rec, args.cwd);
    await args.toolsUntil(rec, s.sessionId, (info) => info.mcp?.servers.some((x) => x.tools?.length), 'mcp tools');
    await rec.until(() => rec.events().some((e) => e.event.type === 'mori.notify' && e.event.message.includes('mori-broken'))
      || rec.events().some((e) => e.event.type === 'mori.notify' && e.event.message.startsWith('MCP servers')),
    'the MCP notice');
    await args.say(rec, s, args.MCP_CALL, ['mcp__mori_test__echo']);
    await rec.cmd({ type: 'tools.get', sessionId: s.sessionId });
  } }],
  check: (steps) => {
    const s = values(steps, 'session.create')[0];
    const tools = values(steps, 'tools.get').at(-1);
    const server = (name) => tools?.mcp?.servers.find((x) => x.name === name);
    const notices = eventsOf(steps, 'mori.notify').map((e) => e.event.message).join('\n');
    const asked = eventsOf(steps, 'mori.approval_request').some((e) => e.event.toolName === 'mcp__mori_test__echo');
    const result = eventsOf(steps, 'tool_execution_end').map((e) => JSON.stringify(e.event.result)).join(' ');
    return [...common(steps), ...need(server('mori-test')?.tools?.includes('mcp__mori_test__echo'), 'mori-test tools'),
      ...need(server('mori-empty')?.tools?.length === 0, 'mori-empty has no tools'),
      ...need(notices.includes('mori-broken: failed'), `notice: ${notices.slice(0, 200)}`),
      ...need(asked, 'approval card for the MCP tool'), ...need(result.includes('mori-mcp echo: hello-mori'), 'echo result'),
      ...need(Boolean(s), 'session')];
  } };

/** @brief plugin：添加本地包，按资源启停，停用 / 启用整个包，新会话里它的扩展工具出批准卡。 */
const plugin = { name: 'plugin', description: '添加本地文件夹的 pi 包（tests/pi-package 的副本）：工具页列出扩展、技能、提示词、主题；'
    + '停用包里的技能，停用整个包、再启用整个包；新会话里包的扩展注册的 package_hello 出批准卡、允许后返回',
  phases: [{ node: (steps, args) => {
    cpSync(join(appRoot, 'tests', 'pi-package'), args.pkg, { recursive: true });
  } }, { page: async (rec, args) => {
    await args.list(rec);
    const a = await args.create(rec, args.cwd);
    await rec.cmd({ type: 'tools.get', sessionId: a.sessionId });
    await rec.cmd({ type: 'package.add', path: args.pkg });
    const added = await rec.cmd({ type: 'tools.get', sessionId: a.sessionId });
    const pkg = added.packages[0];
    const skill = pkg.resources.find((r) => r.kind === 'skills');
    await rec.cmd({ type: 'resource.toggle', sessionId: a.sessionId, kind: 'skills', path: skill.path, enabled: false });
    await rec.cmd({ type: 'tools.get', sessionId: a.sessionId });
    await rec.cmd({ type: 'package.setAll', source: pkg.source, enabled: false });
    await rec.cmd({ type: 'tools.get', sessionId: a.sessionId });
    await rec.cmd({ type: 'package.setAll', source: pkg.source, enabled: true });
    await rec.cmd({ type: 'tools.get', sessionId: a.sessionId });
    const b = await args.create(rec, args.cwd);
    await rec.cmd({ type: 'tools.get', sessionId: b.sessionId });
    await args.say(rec, b, args.PACKAGE_CALL, ['package_hello']);
  } }],
  check: (steps) => {
    const infos = values(steps, 'tools.get');
    const kinds = new Set(infos[1]?.packages[0]?.resources.map((r) => r.kind));
    const off = infos[3]?.packages[0]?.resources.every((r) => !r.enabled);
    const result = eventsOf(steps, 'tool_execution_end').map((e) => JSON.stringify(e.event.result)).join(' ');
    return [...common(steps), ...need(kinds.size === 4, `resource kinds ${[...kinds]}`),
      ...need(off, 'whole package off'), ...need(infos.at(-1)?.tools?.some((t) => t.name === 'package_hello'), 'tool'),
      ...need(result.includes('hello from package'), 'package_hello result')];
  } };

/** @brief slash："/"补全的来源（session.commands），发出技能命令和提示词模板。 */
const slash = { name: 'slash', description: '用户级技能 m6-hello 和提示词模板 m6-summary；新会话的"/"补全列出 /m6-summary 和 '
    + '/skill:m6-hello；发出 /skill:m6-hello（pi 展开成技能正文）和 /m6-summary README.md（展开成模板）',
  phases: [{ node: (steps, args) => {
    writeSkill(join(args.agentDir, 'skills', 'm6-hello'), 'm6-hello',
      'Synthetic skill for the Mori M6 walkthrough; when used, reply with exactly M6-SKILL-OK.',
      '# m6-hello\n\nReply with exactly one line: M6-SKILL-OK');
    mkdirSync(join(args.agentDir, 'prompts'), { recursive: true });
    writeFileSync(join(args.agentDir, 'prompts', 'm6-summary.md'),
      '---\ndescription: 用一句话总结一个文件\nargument-hint: "<file>"\n---\n请读取 $1，然后用一句话总结它的内容。\n');
  } }, { page: async (rec, args) => {
    await args.list(rec);
    const s = await args.create(rec, args.cwd);
    await rec.cmd({ type: 'session.commands', sessionId: s.sessionId });
    await args.say(rec, s, args.SLASH_SKILL);
    await args.say(rec, s, args.SLASH_TEMPLATE, ['read']);
  } }],
  check: (steps) => {
    const s = values(steps, 'session.create')[0];
    const names = (values(steps, 'session.commands')[0] ?? []).map((c) => c.name);
    const users = eventsOf(steps, 'message_start').filter((e) => e.sessionId === s?.sessionId
      && e.event.message.role === 'user').map((e) => JSON.stringify(e.event.message.content));
    const texts = replies(steps, s?.sessionId).map(textOf).join(' ');
    return [...common(steps), ...need(names.includes('m6-summary') && names.includes('skill:m6-hello'), `names ${names}`),
      ...need(users[0]?.includes('<skill name=\\"m6-hello\\"'), 'skill expanded'),
      ...need(users[1]?.includes('README.md') && !users[1]?.includes('/m6-summary'), 'template expanded'),
      ...need(texts.includes('M6-SKILL-OK'), 'skill reply')];
  } };

/**
 * @brief 录制的场景：phases 依次执行（page 在页面里录，node 在 node 里做）。check 在录完后核对；dir 是写到的目录
 *        （没有时是 tests/fixtures/m6）。
 */
const scenarios = [modelRange, thinking, agentsMd, projectSkill, mcp, plugin, slash];

// ---------- 执行 ----------

/** @brief 把共用的操作注入页面里的场景函数（页面里没有模块作用域）。 */
function wrap(body) {
  return `async (rec, args) => {
    args.create = ${create.toString()};
    args.list = ${list.toString()};
    args.config = ${config.toString()};
    args.say = ${say.toString()};
    args.toolsUntil = ${toolsUntil.toString()};
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
  return { app, page };
}

/** @brief 依次执行场景的各段：page 在页面里录；node 在 node 里做（准备文件）。 */
async function runPhases(scenario, args, state) {
  let steps = [];
  let fresh = true;
  for (const phase of scenario.phases) {
    if (phase.node) {
      await phase.node(steps, args, state);
    } else {
      steps = await recordInPage(state.mori.page, phase.page, args, fresh);
      fresh = false;
    }
  }
  return steps;
}

/** @brief 一个场景：依次执行各段，核对后写出 fixture（不符合时写到 rejected）。 */
async function runScenario(scenario, context, state) {
  const args = { ...prompts, ...context.args, cwd: state.cwd, mcpServer, pkg: join(state.root, 'pkg'),
    agentDir: join(state.userData, 'pi') };
  const steps = await runPhases(scenario, args, state);
  const fixture = { source: 'real', note: 'Recorded from a real session by tests/ui/m6-record.mjs; do not edit by hand.',
    name: scenario.name, description: scenario.description, endpoint: context.endpoint, model: context.model,
    recordedAt: new Date().toISOString(), steps };
  const problems = scenario.check(steps, args);
  const dir = problems.length ? rejectedDir : scenario.dir ?? outDir;
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

/**
 * @brief 每个场景一个新的临时数据目录、一个新的临时项目和一次新的启动：启动前在复制出的配置里给项目授权公网、默认范围
 *        设为测试分组（测试准备，§14.1）。出错也会关掉 Mori、删掉临时目录。
 */
async function recordFresh(scenario, context) {
  const userData = scratchUserData(source);
  const made = prepareProject('mori-m6-record-');
  const cwd = join(made.root, `m6-${scenario.name}`);
  renameSync(made.project, cwd);
  // 测试准备（synthetic test setup）：项目授权公网，默认范围为 [DeepSeek, GLM] 的分组
  allowRealProject(userData, cwd);
  // 项目文件夹在 Mori 关闭之后才删（MCP 服务以它为工作目录，开着时删不掉）
  const state = { userData, mori: null, root: made.root, cwd };
  try {
    state.mori = await startMori(userData);
    await runScenario(scenario, context, state);
  } catch (error) {
    console.error(`FAIL recording ${scenario.name}: ${oneLine(error, 600)}`);
    process.exitCode = 1;
  } finally {
    await state.mori?.app.close().catch(() => {});
    for (const dir of [userData, state.root].filter(Boolean)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch (error) {
        console.error(`cannot remove ${dir}: ${oneLine(error)}`);
      }
    }
  }
}

/**
 * @brief 走查数据目录里 v1 的提供商（只读 model-config.json 的非机密部分）：首选（DeepSeek）的地址与第一个模型、
 *        测试分组的 id 与它的第一个候选。
 */
function connectionInfo(dir) {
  const [first] = realProviders(dir);
  return { endpoint: first.baseUrl, model: first.ref,
    args: { provider: first.provider, first: first.ref, group: REAL_GROUP } };
}

const context = connectionInfo(source);
for (const scenario of scenarios) {
  if (only && !only.includes(scenario.name)) continue;
  await recordFresh(scenario, context);
}
