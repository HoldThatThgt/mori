// 回放界面测试的入口：先装好回放进程桥（window.mori），再载入真正的界面（src/renderer/src/main.tsx）。
// ?fixture=<名字>&speed=<倍数>&maxGap=<毫秒>&keepDrafts=1。录制文件来自 tests/fixtures/m1–m4，名字不能重复。
// 每次载入先清掉上一个录制留下的草稿和已归档列表（localStorage），keepDrafts=1 时保留（测"重启后草稿还在"）。
// synthetic-long-history 是手写拼出的长会话（synthetic），由真实录制的 queue-steer 会话记录重复 15 次得到，
// 只用来测"先显示 50 条、上滚载入更早的"。

import { createReplayBridge } from './replay.js';

const globbed = {
  ...import.meta.glob('../../fixtures/m1/*.json', { eager: true, import: 'default' }),
  ...import.meta.glob('../../fixtures/m2/*.json', { eager: true, import: 'default' }),
  ...import.meta.glob('../../fixtures/m3/*.json', { eager: true, import: 'default' }),
  ...import.meta.glob('../../fixtures/m4/*.json', { eager: true, import: 'default' }),
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

if (params.get('keepDrafts') !== '1') {
  localStorage.removeItem('mori.drafts');
  localStorage.removeItem('mori.draftRefs');
  localStorage.removeItem('mori.archived');
}
const data = name === 'synthetic-long-history' ? longHistory() : fixture(name);
const { bridge, control } = createReplayBridge(data, {
  speed: Number(params.get('speed') ?? 1),
  maxGap: Number(params.get('maxGap') ?? 1500),
});
window.mori = bridge;
window.__replay = control;
await import('../../../src/renderer/src/main.tsx');
