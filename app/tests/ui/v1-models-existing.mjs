// 现有功能不退步：依次以子进程跑一组现有套件，每个套件按退出码记一条 "<编号> <脚本名>"，App 套件记进 App 层的结果文件，
// 回放套件记进回放层的结果文件。--id 选编号（默认 MP-37），编号带来结果文件名、套件列表与附加检查的默认值：
//   MP-37（docs/specs/model-providers.md §14.2–§14.4）：App 套件（smoke、m1–m7 的 App 测试）记进
//     test-results/v1-models-app-existing.json，回放套件（m1–m7 的回放测试）记进 test-results/v1-models-replay-existing.json。
//   TB-46（docs/specs/parallel-agents-taskboard.md §17.2–§17.4）：套件列表 taskboard（上面的全部，加
//     v1-models-app-settings、-switch、-session 与 v1-models-replay），App 套件记进 tb-app-existing.json；
//     回放层的 tb-replay-existing.json 依次记 "TB-46 test:unit"（npm run test:unit，模型层的单元）、回放套件、
//     "TB-46 spec-coverage"（node tests/spec-coverage.mjs，模型层的覆盖检查，按退出码 0 记通过，最后跑）。
//     覆盖检查读前面刚写的 v1-unit.json、v1-models-app-*.json、v1-models-replay.json；MP-37 的两个结果文件与
//     v1-models-real.json 不由 TB-46 写，要已经存在（npm run test:v1-models 与真实走查留下的），否则这一条失败。
// 各套件自己的结果文件照旧写（m1-app.json 等）；这里另把每个套件的输出存到 test-results/<日志目录>/<脚本名>.log
// （MP-37 为 v1-models-existing，TB-46 为 tb-existing；脚本名里的 ":" 换成 "-"），失败时检查的细节里带它打印的 FAIL 行。
// 套件要求 out/ 里已是最新构建（npm run test:v1-models 先 electron-vite build，这里不构建）。现有套件用固定端口
// （4319–4371），不要和别的现有套件同时跑。
// 用法（在 app/ 下）：
//   node tests/ui/v1-models-existing.mjs [--id MP-37|TB-46] [--only m0-smoke,m1-replay] [--exe <Mori.exe>]
//     [--app-file <名字.json>] [--replay-file <名字.json>] [--suites models|taskboard] [--with-unit] [--with-coverage]
// --app-file、--replay-file、--suites 换掉编号的默认值；--with-unit、--with-coverage 加上上面两条附加检查（TB-46 默认带）。
// --exe：只跑 App 套件（回放与两条附加检查不经过构建），把 --exe 传给支持它的套件，App 层的结果文件名在 .json 前加
// -packaged（v1-models-app-existing-packaged.json、tb-app-existing-packaged.json）。
// m1-layout.mjs 是检查库、单独运行什么也不做：它的布局检查（含 §14.4 的 Models 分节测量）在 m1-replay 的 layout 一项里跑，
// 随 m1-replay 记一条。退出码为 0 但一条 PASS 都没有的套件记为失败（没跑任何检查不能算通过）；覆盖检查不打印 PASS 行，只看退出码。
// --only 只跑一部分时结果写到部分结果文件，不写上面的文件：MP-37 为 v1-models-existing-partial-app(-packaged).json /
// -partial-replay.json，TB-46 为 tb-partial-existing-app(-packaged).json / tb-partial-existing-replay.json。
// 覆盖检查（tests/spec-coverage.mjs）只认跑全了的结果，一部分套件通过不能算 MP-37 或 TB-46 通过。
// 参数不认识时退出码为 2。

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine } from './lib.mjs';

/** 每个套件最长跑多久（m3、m6 的 App 套件要十几分钟） */
const SUITE_TIMEOUT_MS = 60 * 60 * 1000;
/** 套件输出里失败的那几行（createRecorder 与单元报告器打印的 FAIL / KNOWN） */
const FAIL_LINE = /^(FAIL|KNOWN)\b/;

/**
 * @brief 一个现有套件。
 * @param name 脚本名（tests/ui/<name>.mjs）
 * @param takesExe 是否支持 --exe
 */
const suite = (name, takesExe) => ({ name, takesExe, command: [join(appRoot, 'tests/ui', `${name}.mjs`)],
  needsPass: true, failLine: FAIL_LINE, what: 'the existing suite passes' });

/** §14.4 的 App 套件（npm 脚本 smoke、test:app、test:m2-app … test:m7-app） */
const APP_SUITES = [
  suite('m0-smoke', true), suite('m1-app', true), suite('m2-app', true), suite('m3-app', true), suite('m4-app', true),
  suite('m5-app', true), suite('m6-app-settings', true), suite('m6-app-tools', true), suite('m6-app-slash', true),
  suite('m6-app-mcp-shared', true), suite('m7-app', true),
];
/** §14.4 的回放套件（test:replay、test:m2-replay … test:m7-replay） */
const REPLAY_SUITES = ['m1-replay', 'm2-replay', 'm3-replay', 'm4-replay', 'm5-replay', 'm6-replay', 'm7-replay']
  .map((name) => suite(name, false));

/**
 * @brief 套件列表：名字 → { app, replay }。
 *        models 为模型层 §14.4 的套件；taskboard 为 TaskBoard §17.4 的 TB-46：再加模型层的 App 与回放套件。
 */
const SUITE_LISTS = {
  models: { app: APP_SUITES, replay: REPLAY_SUITES },
  taskboard: {
    app: [...APP_SUITES, suite('v1-models-app-settings', true), suite('v1-models-app-switch', true),
      suite('v1-models-app-session', true)],
    replay: [...REPLAY_SUITES, suite('v1-models-replay', false)],
  },
};

/** 附加检查：模型层的单元测试（经 npm，命令行与 package.json 的 test:unit 一致） */
const UNIT_CHECK = { name: 'test:unit', takesExe: false, shell: 'npm run test:unit', needsPass: true,
  failLine: FAIL_LINE, what: 'the model unit tests pass' };
/** 附加检查：模型层的覆盖检查（不打印 PASS 行，只看退出码；失败时细节里带它列出的缺口，缺口行以两个空格和编号开头） */
const COVERAGE_CHECK = { name: 'spec-coverage', takesExe: false, command: [join(appRoot, 'tests/spec-coverage.mjs')],
  needsPass: false, failLine: /^ {2}MP-\d+ /, what: 'the model coverage check exits 0' };

/**
 * @brief 各编号的默认值。appFile、replayFile 为跑全时的结果文件（appFile 在 --exe 时加 -packaged）；
 *        partial 为 --only 时结果文件名的前缀（后接 app(-packaged).json、replay.json）；logDir 为日志目录名
 *        （--exe 时加 -packaged）；suites 为 SUITE_LISTS 的名字；withUnit、withCoverage 为是否带两条附加检查。
 */
const PRESETS = {
  'MP-37': { appFile: 'v1-models-app-existing.json', replayFile: 'v1-models-replay-existing.json',
    partial: 'v1-models-existing-partial-', logDir: 'v1-models-existing', suites: 'models',
    withUnit: false, withCoverage: false },
  'TB-46': { appFile: 'tb-app-existing.json', replayFile: 'tb-replay-existing.json',
    partial: 'tb-partial-existing-', logDir: 'tb-existing', suites: 'taskboard', withUnit: true, withCoverage: true },
};

/** @brief 参数不认识时打印原因并以退出码 2 结束。 */
function usageError(message) {
  console.error(`[v1-models-existing] ${message}`);
  process.exit(2);
}

/**
 * @brief 解析命令行：编号的默认值加上各参数。
 * @return { id, only, exePath, lists, logName, logDir, appFile, replayFile, withUnit, withCoverage }；
 *         logName 为 test-results/ 下的日志目录名，appFile、replayFile 为这次实际写的结果文件
 */
function readOptions() {
  const id = arg('id') ?? 'MP-37';
  if (!Object.hasOwn(PRESETS, id)) usageError(`unknown --id "${id}" (expected ${Object.keys(PRESETS).join(' or ')})`);
  const preset = PRESETS[id];
  const listName = arg('suites') ?? preset.suites;
  if (!Object.hasOwn(SUITE_LISTS, listName)) {
    usageError(`unknown --suites "${listName}" (expected ${Object.keys(SUITE_LISTS).join(' or ')})`);
  }
  const appFile = arg('app-file') ?? preset.appFile;
  const replayFile = arg('replay-file') ?? preset.replayFile;
  for (const file of [appFile, replayFile]) {
    if (!file.endsWith('.json')) usageError(`result file "${file}" must end with .json`);
  }
  const only = arg('only')?.split(',');
  const exePath = arg('exe') ? resolve(arg('exe')) : null;
  const suffix = exePath ? '-packaged' : '';
  const logName = `${preset.logDir}${suffix}`;
  return {
    id, only, exePath, lists: SUITE_LISTS[listName], logName, logDir: join(appRoot, 'test-results', logName),
    appFile: only ? `${preset.partial}app${suffix}.json` : appFile.replace(/\.json$/, `${suffix}.json`),
    replayFile: only ? `${preset.partial}replay.json` : replayFile,
    withUnit: preset.withUnit || process.argv.includes('--with-unit'),
    withCoverage: preset.withCoverage || process.argv.includes('--with-coverage'),
  };
}

const options = readOptions();
mkdirSync(options.logDir, { recursive: true });

/** @brief 日志文件名：脚本名里的 ":" 在 Windows 的文件名里不能用。 */
const logFileOf = (entry) => `${entry.name.replace(/:/g, '-')}.log`;

/**
 * @brief 以子进程跑一个套件或附加检查，输出同时打到终端并存进日志。
 * @param entry suite()、UNIT_CHECK 或 COVERAGE_CHECK
 * @param args 追加给脚本的参数（--exe）
 * @return { code, output, ms }；超时时 code 为 null
 */
function runSuite(entry, args) {
  const started = Date.now();
  return new Promise((done) => {
    const spawnOptions = { cwd: appRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] };
    const child = entry.shell ? spawn(entry.shell, { ...spawnOptions, shell: true })
      : spawn(process.execPath, [...entry.command, ...args], spawnOptions);
    let output = '';
    const take = (chunk, stream) => {
      output += String(chunk);
      stream.write(chunk);
    };
    child.stdout.on('data', (chunk) => take(chunk, process.stdout));
    child.stderr.on('data', (chunk) => take(chunk, process.stderr));
    const timer = setTimeout(() => {
      output += `\n[v1-models-existing] ${entry.name} timed out after ${SUITE_TIMEOUT_MS / 60000} min\n`;
      child.kill();
    }, SUITE_TIMEOUT_MS);
    child.on('error', (error) => {
      output += `\n[v1-models-existing] cannot start ${entry.name}: ${error.message}\n`;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: signal ? null : code, output, ms: Date.now() - started });
    });
  });
}

/** @brief 细节：退出码、用时、日志位置，失败时带前几条 FAIL 行。 */
function detailOf(entry, { code, output, ms }, note) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const fails = lines.filter((line) => entry.failLine.test(line));
  const counts = `${lines.filter((line) => line.startsWith('PASS ')).length} PASS, ${fails.length} FAIL`;
  const head = `exit ${code ?? 'timeout'}, ${Math.round(ms / 1000)} s, ${counts}, log test-results/`
    + `${options.logName}/${logFileOf(entry)}${note ? `; ${note}` : ''}`;
  return code === 0 ? head : `${head}; ${fails.slice(0, 6).map((line) => oneLine(line, 160)).join(' | ')}`;
}

/** @brief 跑一组套件，每个记一条 "<编号> <脚本名>"，写结果文件；返回是否全部通过。 */
async function runGroup(entries, resultFile) {
  const { exePath, only, id } = options;
  const recorder = createRecorder(exePath ?? 'dev build');
  const chosen = entries.filter((entry) => !only || only.includes(entry.name));
  if (chosen.length === 0) return true;
  for (const entry of chosen) {
    console.log(`\n[v1-models-existing] ==== ${entry.name} ====`);
    const args = exePath && entry.takesExe ? ['--exe', exePath] : [];
    const note = exePath && !entry.takesExe ? 'no --exe support, ran against the dev build' : '';
    const run = await runSuite(entry, args);
    writeFileSync(join(options.logDir, logFileOf(entry)), run.output);
    const ran = !entry.needsPass || /^PASS /m.test(run.output.replace(/\x1b\[[0-9;]*m/g, ''));
    recorder.record(`${id} ${entry.name}: ${entry.what}`, run.code === 0 && ran,
      `${ran ? '' : 'no PASS line, the suite ran no checks; '}${detailOf(entry, run, note)}`);
  }
  return recorder.write(resultFile);
}

const { lists, exePath, withUnit, withCoverage } = options;
const replayEntries = [...(withUnit ? [UNIT_CHECK] : []), ...lists.replay, ...(withCoverage ? [COVERAGE_CHECK] : [])];
const appOk = await runGroup(lists.app, options.appFile);
const replayOk = exePath ? true : await runGroup(replayEntries, options.replayFile);
process.exitCode = appOk && replayOk ? 0 : 1;
