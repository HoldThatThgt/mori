// kernel/defaultTools.ts 的单元测试（负责人走查 M12 "why can't I enable them?"，docs/v0/screens/tools.md"内置工具"）：
// Customize 内置工具的开关写用户级 settings.json 的 defaultTools。选默认工具的规则照写 pi 1.3.0，这里逐条对照 pi 真实的
// SettingsManager；写入在 pi 的文件锁里只改这一项，与 pi 自己的保存（例如按模型的思考强度）交错时两边都不丢。
// 设置文件都写在临时目录里（synthetic），测完删掉。U77 的两条用真的 pi 会话（内存里的会话记录与设置），工具照 sessions.ts：
// customTools 是 Mori 换掉的 bash、powershell。审查后补（2026-10-29）：U77 的 heldOff（没有 bash 时开着也没有，对照 pi
// 合并内存里的设置）与 U76 的带 ; 的 PATH 项。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pi from '@earendil-works/pi-coding-agent';
import { loadKernelModule } from './load.mjs';

const { SessionManager, SettingsManager } = pi;
const { selectedTools, mergedTools, toolDefaults, switchedTools, reopenedTools, rewrittenSettings, writeDefaultTool,
  isBuiltinTool, refreshedTools, installedSearchTools } = await loadKernelModule('src/kernel/defaultTools.ts');
const { applyShell, memoryDefaultTools, NO_BASH_TOOLS } = await loadKernelModule('src/kernel/shell.ts');
const { shellTools } = await loadKernelModule('src/kernel/workspace.ts');
const { toolSource } = await loadKernelModule('src/kernel/resources.ts');

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
    assert.deepEqual(plain.get(name), { enabled: DEFAULTS.includes(name), byProject: false, heldOff: false }, name);
  }
  // heldOff（2026-10-29 U77 加）：项目设置去掉的 edit 开着也没有
  const project = toolDefaults(['+ls'], ['+grep', '-edit']);
  assert.deepEqual(project.get('grep'), { enabled: true, byProject: true, heldOff: false });
  assert.deepEqual(project.get('edit'), { enabled: false, byProject: true, heldOff: true });
  assert.deepEqual(project.get('ls'), { enabled: true, byProject: false, heldOff: false });
  assert.deepEqual(project.get('read'), { enabled: true, byProject: false, heldOff: false });
  assert.deepEqual(project.get('powershell'), { enabled: false, byProject: false, heldOff: false });
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

test('M12 defaultTools: reopenedTools turns the built-in tools of a reopened session into today’s defaults', () => {
  const restored = ['read', 'bash', 'edit', 'write', 'switch_hello', 'memory'];
  // 打开 ls、grep 之后：内置工具按现在的设置（排在前面），别的工具照恢复的留着，最后加上还没启用的扩展工具
  assert.deepEqual(reopenedTools(restored, PI_TOOLS, [...DEFAULTS, 'ls', 'grep'], ['mcp__s__echo']),
    ['read', 'bash', 'edit', 'write', 'ls', 'grep', 'switch_hello', 'memory', 'mcp__s__echo']);
  // 关掉 bash 之后：恢复的 bash 不再启用
  assert.deepEqual(reopenedTools(restored, PI_TOOLS, ['read', 'edit', 'write'], []),
    ['read', 'edit', 'write', 'switch_hello', 'memory']);
  // 设置里写了没注册的名字（synthetic）时不启用它
  assert.deepEqual(reopenedTools(['read'], ['read', 'ls'], ['read', 'ls', 'missing'], []), ['read', 'ls']);
});

test('M12 defaultTools: reopenedTools leaves a reopened session alone when its tools already match', () => {
  // 同一组工具、顺序不同：不重设（null），恢复的顺序不动
  assert.equal(reopenedTools(['memory', 'read', 'bash', 'edit', 'write'], PI_TOOLS, DEFAULTS, []), null);
  assert.equal(reopenedTools([], PI_TOOLS, [], []), null);
  // 只差还没启用的扩展工具时照旧补上（信任之后重新打开不信任时保存的会话）
  assert.deepEqual(reopenedTools(['read', 'bash', 'edit', 'write'], PI_TOOLS, DEFAULTS, ['ext_tool']),
    ['read', 'bash', 'edit', 'write', 'ext_tool']);
});

// ---- U77：重新打开的会话里 Mori 换掉的 bash、powershell 也按开关换（docs/v1/walkthrough-1026-checks.md 的 U77） ----

/**
 * @brief 真的 pi 会话（内存里的会话记录与设置，synthetic），工具照 sessions.ts 建会话：customTools 是 Mori 换掉的 bash、
 *        powershell（workspace.ts shellTools），pi 给它们的来源是 sdk。active 是“恢复出的”启用工具。
 */
async function piSession(t, active) {
  const dir = tempDir(t);
  const settings = SettingsManager.inMemory({});
  const { session } = await pi.createAgentSession({ cwd: dir, agentDir: dir, settingsManager: settings,
    sessionManager: SessionManager.inMemory(dir), customTools: shellTools(pi, dir, settings) });
  t.after(() => session.dispose());
  session.setActiveToolsByName(active);
  return session;
}

test('U77 defaultTools: isBuiltinTool counts pi’s built-in tools and the bash and powershell Mori replaces '
  + '(source sdk), the same as the Tools page source; not MCP, extension or Mori tools', async (t) => {
  const session = await piSession(t, DEFAULTS);
  const tools = session.getAllTools();
  const shells = tools.filter((tool) => ['bash', 'powershell'].includes(tool.name)).map((tool) => tool.sourceInfo);
  assert.deepEqual(shells.map((info) => [info.path, info.source]), [['<sdk:bash>', 'sdk'],
    ['<sdk:powershell>', 'sdk']], 'pi gives the replaced shell tools source sdk');
  assert.deepEqual(tools.filter(isBuiltinTool).map((tool) => tool.name).sort(), [...PI_TOOLS].sort());
  assert.ok(tools.every((tool) => toolSource(tool).source === 'builtin'), 'the Tools page says Built-in for all eight');
  const others = [{ path: 'builtin:mcp', source: 'builtin' }, { path: 'C:/project/.pi/extensions/x.ts',
    source: 'local' }, { path: '<inline:mori-team>', source: 'local' }, { path: 'C:/pkg/ext.ts', source: 'pkg',
    origin: 'package' }];
  for (const sourceInfo of others) {
    assert.equal(isBuiltinTool({ sourceInfo }), false, sourceInfo.path);
    assert.notEqual(toolSource({ name: 'x', sourceInfo }).source, 'builtin', sourceInfo.path);
  }
});

test('U77 defaultTools: refreshedTools turns powershell on and bash off in a reopened session, and back', async (t) => {
  const session = await piSession(t, DEFAULTS);
  // 关掉 bash、打开 powershell 之后重新打开：bash 不再启用，powershell 启用（原来只认 builtin: 的来源，两样都不变）
  const off = refreshedTools(session, selectedTools(['-bash', '+powershell']));
  assert.deepEqual(off, ['read', 'edit', 'write', 'powershell']);
  session.setActiveToolsByName(off);
  assert.deepEqual(session.getActiveToolNames(), off, 'pi takes the new loadout');
  // 再打开 bash、关掉 powershell：回到 pi 的默认
  assert.deepEqual(refreshedTools(session, selectedTools(undefined)), DEFAULTS);
  // 和现在的设置相同时不重设
  assert.equal(refreshedTools(session, selectedTools(['-bash', '+powershell'])), null);
});

test('U77 defaultTools: heldOff marks the tools new sessions lack even with the switch on, as pi merges Mori’s '
  + 'in-memory -bash (no Git Bash); the switch itself does not change it', () => {
  for (const user of VALUES) {
    const states = toolDefaults(user, undefined, NO_BASH_TOOLS);
    for (const name of PI_TOOLS) {
      // pi 自己：用户级设置是按开了这个开关写的，再放 Mori 没有 bash 时放的内存设置（shell.ts applyShell）
      const on = switchedTools(user, name, true);
      const settings = SettingsManager.inMemory(on === undefined ? {} : { defaultTools: on });
      applyShell(settings, { kind: 'none' });
      const piHas = (settings.getDefaultTools() ?? DEFAULTS).includes(name);
      assert.equal(states.get(name).heldOff, !piHas, `${JSON.stringify(user)}: ${name}`);
      assert.equal(toolDefaults(switchedTools(user, name, false), undefined, NO_BASH_TOOLS).get(name).heldOff,
        states.get(name).heldOff, `${name}: the same with the switch off`);
    }
  }
  const noBash = toolDefaults(undefined, undefined, NO_BASH_TOOLS);
  assert.deepEqual(PI_TOOLS.filter((name) => noBash.get(name).heldOff), ['bash']);
  assert.ok(PI_TOOLS.every((name) => !toolDefaults(['-bash'], undefined, undefined).get(name).heldOff),
    'with bash found nothing is held off');
  assert.equal(toolDefaults(undefined, ['read'], undefined).get('ls').heldOff, true, 'a project list without it');
  assert.deepEqual(memoryDefaultTools({ getShellPath: () => undefined }, { kind: 'none' }), NO_BASH_TOOLS);
  assert.equal(memoryDefaultTools({ getShellPath: () => 'E:\\tools\\bash.exe' }, { kind: 'none' }), undefined);
  assert.equal(memoryDefaultTools({ getShellPath: () => undefined }, { kind: 'pi', shellPath: 'C:\\bash.exe' }),
    undefined);
});

test('U76 defaultTools: installedSearchTools does not split a quoted PATH folder that has ";" in it', () => {
  const bin = 'C:\\agent\\bin';
  const only = (...files) => (path) => files.includes(path);
  const dir = 'C:\\Mori;x\\resources\\bin';
  assert.deepEqual(installedSearchTools(bin, `"${dir}";C:\\a`, only(join(dir, 'rg.exe'), join(dir, 'fd.exe'))),
    ['grep', 'find']);
  assert.deepEqual(installedSearchTools(bin, `C:\\a; "${dir}" ;C:\\b`, only(join(dir, 'fd.exe'))), [],
    'like libuv: spaces are kept, so a quote after a space does not count and the folder splits');
  assert.deepEqual(installedSearchTools(bin, `'${dir}';C:\\a`, only(join(dir, 'rg.exe'), join(dir, 'fd.exe'))),
    ['grep', 'find'], 'single quotes count too');
  assert.deepEqual(installedSearchTools(bin, `"${dir};C:\\a`, only(join(`${dir};C:\\a`, 'fd.exe'))), ['find'],
    'an unclosed quote makes the rest of PATH one folder');
  assert.deepEqual(installedSearchTools(bin, `${dir};C:\\a`, only(join(dir, 'rg.exe'))), [],
    'unquoted, the folder splits in two and is not found');
});
