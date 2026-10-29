// 结果文件的戳（docs/v1/test-strategy.md §3.2，AGENTS.md“测试分层”）：createRecorder 写结果文件时记下这次运行用的
// 测试代码与构建，之后据此判断一个套件整套跑出的结果还算不算数：
//   tests：套件脚本与它在 tests/ 里传递 import 的文件，加上所有套件共用的测试数据（合成端点、MCP 服务、pi 包、fixture、
//          tests/ui 下不是 .mjs 的文件）；
//   build：App 与真实层是开发构建的输入（src、package-lock.json、构建与 TypeScript 配置；out/ 比 src 旧时为 null，
//          这次运行测的不是现在的源码）；回放是回放页面的输入（src/renderer、src/shared、tests/ui/harness、fixture、
//          package-lock.json），回放不启动主进程与后台进程；--exe 时是那份 app.asar；
//   commit、dirty、at：跑的时候的提交、工作区是否有改动、时刻，只作记录。
// 结果“还算数”（freshness）：结果文件在、有戳、tests 与 build 都和现在相同、至少一条通过、没有失败（known 照
// createRecorder 的规则不算失败）。
// 用法：被 lib.mjs（写戳）、run.mjs、v1-models-existing.mjs、spec-coverage.mjs（判断）引用；单元测试见
// tests/unit/stamp.test.mjs。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const appRoot = resolve(import.meta.dirname, '../..');

/** 所有套件共用的测试数据（相对 app/） */
const SHARED_TEST_INPUTS = ['tests/fake-endpoint', 'tests/mcp-server', 'tests/pi-package', 'tests/fixtures'];
/** 开发构建的输入（相对 app/）：vendor/bin 的 rg、fd 由主进程放进后台进程的 PATH（U76） */
const APP_INPUTS = ['src', 'vendor', 'package-lock.json', 'electron.vite.config.ts', 'tsconfig.json',
  'tsconfig.node.json', 'tsconfig.web.json'];
/** 回放页面的输入（相对 app/）：harness/main.jsx 从 src/renderer 的源码构建，并把全部 fixture 打进去 */
export const HARNESS_INPUTS = ['src/renderer', 'src/shared', 'tests/ui/harness', 'tests/fixtures', 'package-lock.json'];
/** 开发构建的产物：三个都比 src 新时 out/ 才是现在的源码建的 */
const BUILD_OUTPUTS = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'];
/** 脚本里相对路径的 import / require / 动态 import */
const LOCAL_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)'(\.{1,2}\/[^']+)'/g;

/** @brief 一个路径（文件或目录）下的全部文件，绝对路径，按字母排序；不存在时为空。 */
function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).filter((name) => name !== 'node_modules').sort()
    .flatMap((name) => filesUnder(join(path, name)));
}

/** 这个进程里已经算过的哈希：键为文件列表与每个文件的修改时刻、大小（都没变时不再读内容） */
const cache = new Map();

/**
 * @brief 一组文件与目录的哈希：每个文件按相对 app/ 的路径（/ 分隔）和内容计入。
 * @param paths 绝对路径或相对 app/ 的路径
 * @return 十六进制的 sha256
 */
export function treeHash(paths) {
  const files = [...new Set(paths.flatMap((path) => filesUnder(resolve(appRoot, path))))].sort();
  const key = files.map((file) => {
    const info = statSync(file);
    return `${file}|${info.mtimeMs}|${info.size}`;
  }).join('\n');
  if (cache.has(key)) return cache.get(key);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(appRoot, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  const value = hash.digest('hex');
  cache.set(key, value);
  return value;
}

/**
 * @brief 脚本与它传递 import 的、在 tests/ 里的文件（静态 import、动态 import 与 require 的相对路径）。
 * @param script 绝对路径
 * @return 绝对路径的集合
 */
export function importClosure(script) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !existsSync(file) || !/\.(mjs|js|cjs|jsx)$/.test(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(LOCAL_IMPORT)) {
      const target = resolve(dirname(file), match[1]);
      if (relative(join(appRoot, 'tests'), target).startsWith('..')) continue;
      visit(target);
    }
  };
  visit(resolve(script));
  return seen;
}

/** @brief 套件的层：脚本名以 -replay 结尾为回放，以 -real 结尾为真实层，其余为 App。 */
export const layerOf = (name) => (/-replay$/.test(name) ? 'replay' : /-real$/.test(name) ? 'real' : 'app');

/** @brief tests/ui 下不是 .mjs 的文件（tray-hook.cjs、uninstall-ui.ps1 等，按路径读，不经 import） */
const uiDataFiles = () => readdirSync(join(appRoot, 'tests/ui')).filter((name) => !/\.mjs$/.test(name))
  .map((name) => join(appRoot, 'tests/ui', name)).filter((path) => !statSync(path).isDirectory());

/** @brief 套件测试代码的哈希（见文件开头 tests）。 */
export const testsHash = (script) => treeHash([...importClosure(script), ...uiDataFiles(), ...SHARED_TEST_INPUTS]);

/** @brief 开发构建的产物是不是比 src 里最新的文件新（不是时这次运行测的不是现在的源码）。 */
export function buildIsCurrent() {
  const outputs = BUILD_OUTPUTS.map((path) => join(appRoot, path));
  if (!outputs.every(existsSync)) return false;
  const built = Math.min(...outputs.map((path) => statSync(path).mtimeMs));
  return Math.max(...filesUnder(join(appRoot, 'src')).map((path) => statSync(path).mtimeMs)) <= built;
}

/**
 * @brief 构建的哈希（见文件开头 build）。
 * @param name 套件的脚本名（不带 .mjs）
 * @param exePath --exe 的 Mori.exe；开发构建时为 null
 * @return 十六进制的 sha256；开发构建比 src 旧时为 null
 */
export function buildHash(name, exePath = null) {
  if (exePath) return treeHash([join(dirname(exePath), 'resources', 'app.asar')]);
  if (layerOf(name) === 'replay') return treeHash(HARNESS_INPUTS);
  return buildIsCurrent() ? treeHash(APP_INPUTS) : null;
}

/** @brief 跑一条 git 命令，失败时为 null（只作记录）。 */
function gitOut(args) {
  try {
    return execFileSync('git', args, { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    console.error(`[stamp] git ${args.join(' ')} failed: ${error.message}`);
    return null;
  }
}

/**
 * @brief 这次运行的戳。
 * @param script 套件脚本的绝对路径（process.argv[1]）
 * @param target createRecorder 的 target：Mori.exe 的路径、"dev build" 或回放的说明
 */
export function stampFor(script, target) {
  const name = (script ?? '').replace(/\\/g, '/').split('/').at(-1).replace(/\.mjs$/, '');
  const exePath = /\.exe$/i.test(String(target)) ? String(target) : null;
  return { script: name, tests: testsHash(script), build: buildHash(name, exePath),
    commit: gitOut(['rev-parse', 'HEAD']), dirty: gitOut(['status', '--porcelain'])?.length > 0,
    at: new Date().toISOString() };
}

/**
 * @brief 戳和现在的测试代码、构建对不对得上。
 * @param stamp 结果文件里的 stamp（没有时为 undefined）
 * @param name 结果文件名（不带 .json）：戳里没记脚本名时按它找脚本（汇总的结果文件由 v1-models-existing 写，戳里有）
 * @param exePath 结果是 --exe 跑的时为那个 Mori.exe
 * @return 对不上的原因（一句英文）；对得上为 null
 */
export function stampProblem(stamp, name, exePath = null) {
  if (!stamp) return 'no stamp: ran before stamps were written';
  const script = stamp.script ?? name;
  if (stamp.tests !== testsHash(join(appRoot, 'tests/ui', `${script}.mjs`))) return 'stale: tests changed';
  if (stamp.build === null) return 'stale: ran on a build older than src';
  return stamp.build === buildHash(script, exePath) ? null : 'stale: build changed';
}

/**
 * @brief 一个套件整套跑出的结果现在还算不算数。
 * @param name 套件的脚本名（不带 .mjs）
 * @param opts { exePath：读 <name>-packaged.json、按那份 app.asar 比；resultsDir：结果目录（默认 test-results） }
 * @return { fresh, reason（不算数时的一句英文）, passed, failed, at（跑的时刻）}
 */
export function freshness(name, { exePath = null, resultsDir = join(appRoot, 'test-results') } = {}) {
  const file = join(resultsDir, `${name}${exePath ? '-packaged' : ''}.json`);
  if (!existsSync(file)) return { fresh: false, reason: 'missing: never ran in full', passed: 0, failed: 0, at: null };
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const passed = result.checks.filter((check) => check.ok).length;
  const failed = result.checks.filter((check) => !check.ok && !check.known).length;
  const reason = !result.stamp ? stampProblem(result.stamp, name, exePath)
    : failed > 0 ? `failed: ${failed} check(s) failed`
      : passed === 0 ? 'no checks passed' : stampProblem(result.stamp, name, exePath);
  return { passed, failed, at: result.stamp?.at ?? null, fresh: reason === null, reason };
}
