// kernel/shell.ts 的单元测试（负责人走查 M28 "bash not usable in mori"，docs/app-v0.md 第 6 节"Shell"）：
// pi 找不到 bash 时照 Claude Code 的做法从 git.exe 的位置和 Git for Windows 的注册表找 Git Bash；找到的路径与
// "没有 bash 时用 powershell"只放进内存里的 pi 设置。外部查询（where、reg、文件、pi 的查找）与 pi 的设置都是替身（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from './load.mjs';

const { resolveShell, gitRoot, parseInstallPath, applyShell, describeShell, NO_BASH_TOOLS } =
  await loadKernelModule('src/kernel/shell.ts');

/**
 * @brief 替身查询：files 里的路径算存在；calls 记下调过哪些查询（看是否按顺序、该停就停）。
 * @param over 覆盖默认的查询：默认没有设置、pi 找不到、PATH 上没有 git、注册表里没有
 */
function fakeProbe(files = [], over = {}) {
  const calls = [];
  const exists = new Set(files.map((path) => path.toLowerCase()));
  const lookups = { configured: () => undefined, piShell: () => null, gitOnPath: async () => [],
    registryRoots: async () => [], ...over };
  const names = { configured: 'configured', piShell: 'pi', gitOnPath: 'where', registryRoots: 'reg' };
  const probe = { exists: (path) => exists.has(path.toLowerCase()) };
  for (const [key, name] of Object.entries(names)) {
    probe[key] = () => { calls.push(name); return lookups[key](); };
  }
  return { probe, calls };
}

/** @brief 替身 pi 设置：记下 applyOverrides 收到的覆盖；shellPath 为这份设置里已有的值。 */
function fakeSettings(shellPath) {
  const applied = [];
  const settings = { getShellPath: () => shellPath, applyOverrides: (overrides) => applied.push(overrides) };
  return { applied, settings };
}

test('M28 shell: a shellPath already in pi settings is kept and nothing else is looked up', async () => {
  const { probe, calls } = fakeProbe([], { configured: () => 'E:\\tools\\bash.exe' });
  assert.deepEqual(await resolveShell(probe), { kind: 'configured', shellPath: 'E:\\tools\\bash.exe' });
  assert.deepEqual(calls, ['configured']);
});

test('M28 shell: when pi finds bash itself (Program Files or PATH) Mori does not look further', async () => {
  const { probe, calls } = fakeProbe([], { piShell: () => 'C:\\Program Files\\Git\\bin\\bash.exe' });
  assert.deepEqual(await resolveShell(probe), { kind: 'pi', shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' });
  assert.deepEqual(calls, ['configured', 'pi']);
});

test('M28 shell: git.exe in <Git>\\cmd on PATH (the installer default) gives <Git>\\bin\\bash.exe', async () => {
  const { probe, calls } = fakeProbe(['D:\\Git\\bin\\bash.exe'],
    { gitOnPath: async () => ['D:\\Git\\cmd\\git.exe'] });
  assert.deepEqual(await resolveShell(probe), { kind: 'git', shellPath: 'D:\\Git\\bin\\bash.exe', from: 'git.exe' });
  assert.deepEqual(calls, ['configured', 'pi', 'where'], 'the registry is not read when git.exe already gave bash');
});

test('M28 shell: the Git root comes from git.exe in cmd, bin or mingw64\\bin; other places give none', () => {
  assert.equal(gitRoot('D:\\Git\\cmd\\git.exe'), 'D:\\Git');
  assert.equal(gitRoot('D:\\Git\\bin\\git.exe'), 'D:\\Git');
  assert.equal(gitRoot('D:\\Git\\mingw64\\bin\\git.exe'), 'D:\\Git');
  assert.equal(gitRoot('E:\\Apps\\Git\\CMD\\git.exe'), 'E:\\Apps\\Git', 'folder names are matched without case');
  assert.equal(gitRoot('C:\\Users\\me\\scoop\\shims\\git.exe'), null);
});

test('M28 shell: every git.exe from where is tried in order; one without bash.exe next to it is skipped', async () => {
  const { probe } = fakeProbe(['D:\\Git\\bin\\bash.exe'], {
    gitOnPath: async () => ['C:\\Users\\me\\scoop\\shims\\git.exe', 'E:\\Old\\cmd\\git.exe',
      'D:\\Git\\mingw64\\bin\\git.exe'],
  });
  assert.deepEqual(await resolveShell(probe), { kind: 'git', shellPath: 'D:\\Git\\bin\\bash.exe', from: 'git.exe' });
});

test('M28 shell: without git.exe on PATH the Git for Windows registry InstallPath gives <InstallPath>\\bin\\bash.exe',
  async () => {
    const { probe, calls } = fakeProbe(['F:\\PortableGit\\bin\\bash.exe'], {
      registryRoots: async () => ['G:\\Removed', 'F:\\PortableGit'] });
    assert.deepEqual(await resolveShell(probe),
      { kind: 'git', shellPath: 'F:\\PortableGit\\bin\\bash.exe', from: 'registry' });
    assert.deepEqual(calls, ['configured', 'pi', 'where', 'reg']);
  });

test('M28 shell: no shellPath, no bash for pi, no usable git.exe and no registry key means no bash', async () => {
  const { probe } = fakeProbe([], { gitOnPath: async () => ['D:\\Git\\cmd\\git.exe'] });
  assert.deepEqual(await resolveShell(probe), { kind: 'none' });
});

test('M28 shell: InstallPath is read from reg query output (REG_SZ or REG_EXPAND_SZ, spaces in the path)', () => {
  const output = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    D:\\Git\r\n\r\n';
  assert.equal(parseInstallPath(output), 'D:\\Git');
  assert.equal(parseInstallPath('    InstallPath    REG_EXPAND_SZ    C:\\Program Files\\Git  \r\n'),
    'C:\\Program Files\\Git');
  assert.equal(parseInstallPath('ERROR: The system was unable to find the specified registry key or value.\r\n'),
    null);
});

test('M28 shell: Git Bash found by Mori goes into the settings in memory only, as shellPath', () => {
  const { settings, applied } = fakeSettings(undefined);
  applyShell(settings, { kind: 'git', shellPath: 'D:\\Git\\bin\\bash.exe', from: 'git.exe' });
  assert.deepEqual(applied, [{ shellPath: 'D:\\Git\\bin\\bash.exe' }]);
});

test('M28 shell: with no bash at all new sessions get powershell instead of bash (defaultTools in memory)', () => {
  const { settings, applied } = fakeSettings(undefined);
  applyShell(settings, { kind: 'none' });
  assert.deepEqual(NO_BASH_TOOLS, ['-bash', '+powershell']);
  assert.deepEqual(applied, [{ defaultTools: ['-bash', '+powershell'] }]);
});

test('M28 shell: nothing is applied when pi finds bash, or the settings (user or project) set shellPath', () => {
  const plain = fakeSettings(undefined);
  applyShell(plain.settings, { kind: 'pi', shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' });
  applyShell(plain.settings, { kind: 'configured', shellPath: 'E:\\tools\\bash.exe' });
  assert.deepEqual(plain.applied, []);
  const project = fakeSettings('E:\\project-bash\\bash.exe');
  applyShell(project.settings, { kind: 'git', shellPath: 'D:\\Git\\bin\\bash.exe', from: 'registry' });
  applyShell(project.settings, { kind: 'none' });
  assert.deepEqual(project.applied, []);
});

test('M28 shell: the log line says what was found and where it came from, in English', () => {
  assert.equal(describeShell({ kind: 'git', shellPath: 'D:\\Git\\bin\\bash.exe', from: 'git.exe' }),
    'shell: Git Bash D:\\Git\\bin\\bash.exe (from git.exe on PATH), set as shellPath in memory');
  assert.equal(describeShell({ kind: 'git', shellPath: 'D:\\Git\\bin\\bash.exe', from: 'registry' }),
    'shell: Git Bash D:\\Git\\bin\\bash.exe (from the Git for Windows registry key), set as shellPath in memory');
  assert.equal(describeShell({ kind: 'pi', shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe' }),
    'shell: pi finds bash at C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(describeShell({ kind: 'configured', shellPath: 'E:\\tools\\bash.exe' }),
    'shell: pi settings set shellPath E:\\tools\\bash.exe');
  assert.equal(describeShell({ kind: 'none' }),
    'shell: no bash found (pi lookup, git.exe on PATH, Git for Windows registry); new sessions use powershell');
});
