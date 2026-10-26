// kernel/defaultTools.ts 的单元测试（负责人走查 M12 "why can't I enable them?"，docs/v0/screens/tools.md"内置工具"）：
// Customize 内置工具的开关写用户级 settings.json 的 defaultTools。选默认工具的规则照写 pi 1.3.0，这里逐条对照 pi 真实的
// SettingsManager；写入在 pi 的文件锁里只改这一项，与 pi 自己的保存（例如按模型的思考强度）交错时两边都不丢。
// 设置文件都写在临时目录里（synthetic），测完删掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from './load.mjs';

const { selectedTools, mergedTools, toolDefaults, switchedTools, rewrittenSettings, writeDefaultTool } =
  await loadKernelModule('src/kernel/defaultTools.ts');

/** pi 的 8 个内置工具与它默认启用的 4 个 */
const PI_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];
const DEFAULTS = ['read', 'bash', 'edit', 'write'];

/** @brief pi 自己算出的新会话默认工具（getDefaultTools，没写时同 SDK 用 pi 的默认）。 */
const piSelected = (settings) => SettingsManager.inMemory(settings).getDefaultTools() ?? DEFAULTS;

/** @brief 临时目录（synthetic），测完删掉。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-default-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 选默认工具对照用的 defaultTools 写法（含不合规的：不是数组、混着数字、重复） */
const VALUES = [undefined, [], ['+ls'], ['-bash', '+powershell'], ['read', 'ls'], ['read', '+grep', '-read'], 'oops',
  [1, '+ls'], ['+ls', '+ls'], ['-read', '-bash', '-edit', '-write']];

test('M12 defaultTools: selectedTools picks the same tools as pi’s getDefaultTools for every way of writing it', () => {
  for (const value of VALUES) {
    const settings = value === undefined ? {} : { defaultTools: value };
    assert.deepEqual(selectedTools(value), piSelected(settings), JSON.stringify(value));
  }
});

test('M12 defaultTools: mergedTools matches pi when a trusted project also sets defaultTools', (t) => {
  const pairs = [[undefined, ['+grep', '-edit']], [['+ls'], ['+grep']], [['+ls'], ['read']], ['oops', ['+grep']],
    [['-bash'], undefined], [['read'], ['+ls', 'grep']]];
  for (const [user, project] of pairs) {
    const dir = tempDir(t);
    const agentDir = join(dir, 'agent');
    const cwd = join(dir, 'project');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(user === undefined ? {} : { defaultTools: user }));
    writeFileSync(join(cwd, '.pi', 'settings.json'),
      JSON.stringify(project === undefined ? {} : { defaultTools: project }));
    const pi = SettingsManager.create(cwd, agentDir, { projectTrusted: true }).getDefaultTools() ?? DEFAULTS;
    assert.deepEqual(selectedTools(mergedTools(user, project)), pi, JSON.stringify({ user, project }));
  }
});

test('M12 defaultTools: toolDefaults marks the tools a project setting turned on or off, and only those', () => {
  const plain = toolDefaults(undefined, undefined);
  assert.deepEqual([...plain.keys()], PI_TOOLS);
  for (const name of PI_TOOLS) {
    assert.deepEqual(plain.get(name), { enabled: DEFAULTS.includes(name), byProject: false }, name);
  }
  const project = toolDefaults(['+ls'], ['+grep', '-edit']);
  assert.deepEqual(project.get('grep'), { enabled: true, byProject: true });
  assert.deepEqual(project.get('edit'), { enabled: false, byProject: true });
  assert.deepEqual(project.get('ls'), { enabled: true, byProject: false });
  assert.deepEqual(project.get('read'), { enabled: true, byProject: false });
  assert.deepEqual(project.get('powershell'), { enabled: false, byProject: false });
});

test('M12 defaultTools: switchedTools writes the difference from pi’s defaults, "-" entries first', () => {
  const cases = [
    [undefined, 'ls', true, ['+ls']],
    [['+ls'], 'ls', false, undefined],
    [undefined, 'bash', false, ['-bash']],
    [['-bash'], 'ls', true, ['-bash', '+ls']],
    [['-bash', '+ls'], 'ls', false, ['-bash']],
    [['-bash'], 'bash', true, undefined],
    [['-bash', '+powershell'], 'grep', true, ['-bash', '+powershell', '+grep']],
    [['read', 'ls'], 'grep', true, ['-bash', '-edit', '-write', '+ls', '+grep']],
    [['+ls'], 'ls', true, ['+ls']],
    [undefined, 'read', true, undefined],
  ];
  for (const [value, name, enabled, expected] of cases) {
    assert.deepEqual(switchedTools(value, name, enabled), expected, JSON.stringify({ value, name, enabled }));
  }
});

test('M12 defaultTools: turning every default tool off writes "-" entries, which pi reads as no tools '
  + '(never [])', () => {
  let value;
  for (const name of DEFAULTS) value = switchedTools(value, name, false);
  assert.deepEqual(value, ['-read', '-bash', '-edit', '-write']);
  assert.deepEqual(piSelected({ defaultTools: value }), []);
});

test('M12 defaultTools: after any switch pi picks exactly the old tools with that one tool added or removed', () => {
  for (const value of VALUES) {
    const before = selectedTools(value);
    for (const name of PI_TOOLS) {
      for (const enabled of [true, false]) {
        const written = switchedTools(value, name, enabled);
        const after = piSelected(written === undefined ? {} : { defaultTools: written });
        assert.equal(after.includes(name), enabled, JSON.stringify({ value, name, enabled, written }));
        const rest = (list) => [...new Set(list.filter((tool) => tool !== name))].sort();
        assert.deepEqual(rest(after), rest(before), JSON.stringify({ value, name, enabled, written }));
      }
    }
  }
});

test('M12 defaultTools: rewrittenSettings changes only defaultTools and keeps the other fields and their order', () => {
  const file = 'C:\\synthetic\\settings.json';
  const current = `\uFEFF${JSON.stringify({ zeta: 1, defaultTools: ['-bash'], alpha: { nested: true } }, null, 2)}`;
  const once = rewrittenSettings(current, file, 'ls', true);
  assert.equal(once, JSON.stringify({ zeta: 1, defaultTools: ['-bash', '+ls'], alpha: { nested: true } }, null, 2));
  const back = rewrittenSettings(rewrittenSettings(once, file, 'ls', false), file, 'bash', true);
  assert.equal(back, JSON.stringify({ zeta: 1, alpha: { nested: true } }, null, 2));
  assert.equal(rewrittenSettings(undefined, file, 'ls', true), JSON.stringify({ defaultTools: ['+ls'] }, null, 2));
  assert.equal(rewrittenSettings('', file, 'grep', true), JSON.stringify({ defaultTools: ['+grep'] }, null, 2));
});

test('M12 defaultTools: a settings file that is not a JSON object is refused with its path, not overwritten', () => {
  const file = 'C:\\synthetic\\settings.json';
  assert.throws(() => rewrittenSettings('{ "synthetic": ', file, 'ls', true),
    (error) => error.message.startsWith(`${file}: `));
  assert.throws(() => rewrittenSettings('[1, 2]', file, 'ls', true),
    (error) => error.message === `${file}: not a JSON object`);
});

test('M12 defaultTools: writeDefaultTool and pi’s own save under the same file lock both keep their field',
  async (t) => {
  const agentDir = tempDir(t);
  const file = join(agentDir, 'settings.json');
  writeFileSync(file, JSON.stringify({ synthetic: 'keep me', modelThinkingLevels: { 'p/a': 'low' } }, null, 2));
  // pi 的设置先读了文件，Mori 再写 defaultTools，之后 pi 保存按模型的思考强度（pi 只合并它改过的字段）
  const pi = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  await writeDefaultTool(agentDir, 'ls', true);
  pi.setModelThinkingLevel('p', 'b', 'high');
  await pi.flush();
  assert.deepEqual(pi.drainErrors(), []);
  await writeDefaultTool(agentDir, 'bash', false);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { synthetic: 'keep me', modelThinkingLevels: { 'p/a': 'low', 'p/b': 'high' },
    defaultTools: ['-bash', '+ls'] });
  const fresh = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  assert.deepEqual(fresh.getDefaultTools(), ['read', 'edit', 'write', 'ls']);
});

test('M12 defaultTools: writeDefaultTool creates settings.json when there is none, and leaves a broken one alone',
  async (t) => {
    const agentDir = tempDir(t);
    const file = join(agentDir, 'settings.json');
    await writeDefaultTool(agentDir, 'grep', true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { defaultTools: ['+grep'] });
    writeFileSync(file, '{ "synthetic": ');
    await assert.rejects(writeDefaultTool(agentDir, 'ls', true), (error) => error.message.startsWith(`${file}: `));
    assert.equal(readFileSync(file, 'utf8'), '{ "synthetic": ');
  });
