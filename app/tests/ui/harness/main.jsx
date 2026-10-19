// 回放界面测试的入口：先装好回放进程桥（window.mori），再载入真正的界面（src/renderer/src/main.tsx）。
// ?fixture=<名字>&speed=<倍数>&maxGap=<毫秒>。synthetic-long-history 是手写拼出的长会话（synthetic），
// 由真实录制的 queue-steer 会话记录重复 15 次得到，只用来测"先显示 50 条、上滚载入更早的"。

import { createReplayBridge } from './replay.js';

const fixtures = import.meta.glob('../../fixtures/m1/*.json', { eager: true, import: 'default' });
const params = new URLSearchParams(location.search);
const name = params.get('fixture') ?? 'readme';

/** @brief 按名字取录制文件。 */
function fixture(fixtureName) {
  const found = fixtures[`../../fixtures/m1/${fixtureName}.json`];
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
    { t: 2, command: { type: 'session.open', sessionFile: 'synthetic' } },
    { t: 3, result: { type: 'session.open', value: { ...opened.result.value, entries } } },
  ] };
}

const data = name === 'synthetic-long-history' ? longHistory() : fixture(name);
const { bridge, control } = createReplayBridge(data, {
  speed: Number(params.get('speed') ?? 1),
  maxGap: Number(params.get('maxGap') ?? 1500),
});
window.mori = bridge;
window.__replay = control;
await import('../../../src/renderer/src/main.tsx');
