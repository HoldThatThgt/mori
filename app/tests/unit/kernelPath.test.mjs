// main/kernelPath.ts 的单元测试（docs/v0/screens/tools.md“grep、find”，docs/v1/walkthrough-1026-checks.md 的 U76）：
// 主进程启动后台进程时把 Mori 带的 rg.exe、fd.exe 所在的文件夹放在 PATH 最前面。Windows 的环境变量不分大小写，展开的副本
// 只留一种写法（常见 Path），所以只改原有的键、不另建第二个 PATH。最后两条用 app/vendor 里真的程序：按算出的环境起子进程，
// 先找到的是 Mori 带的那一份；程序与 vendor/README.md 写的版本、SHA-256 相同，许可文件都在。
// 审查后补（2026-10-29）：文件夹名里有 ; 时（安装时可以选）这一项加引号，pi 起程序的方式与 installedSearchTools 仍找得到。
// 环境变量里的值都是测试值（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKernelModule } from './load.mjs';

const { withBinOnPath } = await loadKernelModule('src/main/kernelPath.ts');
const { installedSearchTools } = await loadKernelModule('src/kernel/defaultTools.ts');

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendor = join(appRoot, 'vendor');
const bin = join(vendor, 'bin');
/** 测试用的文件夹（synthetic，不必存在） */
const DIR = 'C:\\Synthetic\\Mori\\resources\\bin';

test('U76 kernelPath: the folder goes first under the existing key’s spelling (Path), with no second PATH key', () => {
  const env = { Path: 'C:\\Windows\\system32;C:\\Tools', HOME: 'C:\\Users\\synthetic', PI_OFFLINE: '1' };
  const before = JSON.stringify(env);
  const next = withBinOnPath(env, DIR);
  assert.deepEqual(Object.keys(next), Object.keys(env), 'same keys in the same order');
  assert.equal(next.Path, `${DIR};C:\\Windows\\system32;C:\\Tools`);
  assert.equal(next.HOME, env.HOME);
  assert.equal(next.PI_OFFLINE, '1');
  assert.equal(JSON.stringify(env), before, 'the env passed in is not changed');
  assert.equal(withBinOnPath({ PATH: 'C:\\a' }, DIR).PATH, `${DIR};C:\\a`);
});

test('U76 kernelPath: no PATH key creates PATH; an empty value becomes just the folder; every spelling gets it', () => {
  assert.deepEqual(withBinOnPath({ HOME: 'C:\\h' }, DIR), { HOME: 'C:\\h', PATH: DIR });
  assert.deepEqual(withBinOnPath({ Path: '' }, DIR), { Path: DIR });
  // 两种写法都在时（例如从别的 shell 启动）：两个都加上，不另建第三个
  assert.deepEqual(withBinOnPath({ PATH: 'C:\\a', Path: 'C:\\b' }, DIR),
    { PATH: `${DIR};C:\\a`, Path: `${DIR};C:\\b` });
});

test('U76 kernelPath: a process started with that env finds Mori’s rg.exe and fd.exe first and runs them', () => {
  const { ELECTRON_RENDERER_URL: _url, ...base } = process.env;
  const env = withBinOnPath({ ...base }, bin);
  const where = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
  for (const [exe, version] of [['rg.exe', 'ripgrep 15.2.0'], ['fd.exe', 'fd 10.5.0']]) {
    const found = spawnSync(where, [exe], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(found.stdout.split(/\r?\n/)[0].toLowerCase(), join(bin, exe).toLowerCase(), `${exe} found first`);
    const run = spawnSync(exe.replace('.exe', ''), ['--version'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, `${exe} --version runs`);
    assert.ok(run.stdout.startsWith(version), `${exe} --version: ${run.stdout.trim()}`);
  }
});

test('U76 kernelPath: a folder with ";" goes in quoted; pi’s way of starting rg and fd and installedSearchTools '
  + 'find it', (t) => {
    assert.equal(withBinOnPath({ Path: 'C:\\a' }, 'C:\\x;y\\bin').Path, '"C:\\x;y\\bin";C:\\a');
    assert.equal(withBinOnPath({}, 'C:\\x;y\\bin').PATH, '"C:\\x;y\\bin"');
    // 测试准备（synthetic）：临时目录下名字带 ; 的文件夹，放 Mori 带的两个程序的拷贝
    const root = mkdtempSync(join(tmpdir(), 'mori-kernel-path-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, 'a;b');
    mkdirSync(dir);
    for (const exe of ['rg.exe', 'fd.exe']) copyFileSync(join(bin, exe), join(dir, exe));
    const { ELECTRON_RENDERER_URL: _url, ...base } = process.env;
    const env = withBinOnPath(base, dir);
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
    assert.deepEqual(installedSearchTools(join(root, 'no-bin'), env[pathKey]), ['grep', 'find']);
    // pi getToolPath 按名字起 rg --version / fd --version（child_process，libuv 认带引号的项）
    for (const [exe, version] of [['rg', 'ripgrep 15.2.0'], ['fd', 'fd 10.5.0']]) {
      const run = spawnSync(exe, ['--version'], { env, encoding: 'utf8', windowsHide: true });
      assert.ok(run.status === 0 && run.stdout.startsWith(version), `${exe}: ${run.error ?? run.stdout}`);
    }
  });

test('U76 vendor: rg.exe and fd.exe match the SHA-256 in vendor/README.md, and their licences are there', () => {
  const readme = readFileSync(join(vendor, 'README.md'), 'utf8');
  for (const exe of ['rg.exe', 'fd.exe']) {
    const row = readme.split(/\r?\n/).find((line) => line.startsWith(`| \`bin/${exe}\``)) ?? '';
    const digests = [...row.matchAll(/`([0-9a-f]{64})`/g)].map((match) => match[1]);
    const actual = createHash('sha256').update(readFileSync(join(bin, exe))).digest('hex');
    assert.equal(digests.length, 2, `the README row of ${exe} has the zip and exe digests`);
    assert.equal(actual, digests[1], `${exe} is the file the README lists`);
  }
  const licences = { ripgrep: ['COPYING', 'LICENSE-MIT', 'UNLICENSE'], fd: ['LICENSE-APACHE', 'LICENSE-MIT'] };
  for (const [name, files] of Object.entries(licences)) {
    for (const file of files) assert.ok(existsSync(join(vendor, 'licenses', name, file)), `${name}/${file}`);
  }
});
