// 回放界面测试的入口：先装好回放进程桥（window.mori），再载入真正的界面（src/renderer/src/main.tsx）。
// ?fixture=<名字>&speed=<倍数>&maxGap=<毫秒>&keepDrafts=1&part=before|after。录制文件来自 tests/fixtures/m1–m6、v1、tb、
// mem（m7 随工作回顾删除，docs/specs/memory.md §14.4）、discovery/ui（docs/specs/model-discovery.md §13.1）与
// filesystem（docs/specs/file-system.md §19.1），名字不能重复。part：录制里有一次重启时，取重启前或重启后的一段回放（见 replay.js 的 partOf）。
// 每次载入先清掉上一个录制留下的草稿、已归档列表和 UI issues 的已处理标记（localStorage 的 mori.review，记忆规格 §10.8
// 沿用这个键），keepDrafts=1 时保留（测"重启后草稿还在"）。
// synthetic-long-history 是手写拼出的长会话（synthetic），由真实录制的 queue-steer 会话记录重复 15 次得到，
// 只用来测"先显示 50 条、上滚载入更早的"。synthetic-mcp-setup 是 m6 的 mcp 录制前面补一个先打开的会话（synthetic，
// 见 mcpSetup），让界面能照录制的顺序在工具页里添加 MCP 服务。

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
  // 记忆（docs/specs/memory.md §14.1）：从真实的 App 对合成端点录下（synthetic）；文件夹为空或还没有时同样是空对象
  ...import.meta.glob('../../fixtures/mem/*.json', { eager: true, import: 'default' }),
  // 一键拉取模型（docs/specs/model-discovery.md §13.1）：md-record.mjs 从真实的 App 录下（各文件的 source 写明 real 或
  // synthetic）；文件夹为空或还没有时同样是空对象
  ...import.meta.glob('../../fixtures/discovery/ui/*.json', { eager: true, import: 'default' }),
  // 文件系统（docs/specs/file-system.md §19.1）：fs-real.mjs 从真实会话录下（work-scratch、full-outside、away-reminder）；
  // 文件夹为空或还没有时同样是空对象
  ...import.meta.glob('../../fixtures/filesystem/*.json', { eager: true, import: 'default' }),
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

/** synthetic 的录制：名字 → 拼法 */
const SYNTHETIC = { 'synthetic-long-history': longHistory, 'synthetic-mcp-setup': mcpSetup };

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
});
window.mori = bridge;
window.__replay = control;
await import('../../../src/renderer/src/main.tsx');
