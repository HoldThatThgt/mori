// 现有功能不退步：依次以子进程跑一组现有套件，每个套件按退出码记一条 "<编号> <脚本名>"，App 套件记进 App 层的结果文件，
// 回放套件记进回放层的结果文件。--id 选编号（默认 MP-37），编号带来结果文件名、套件列表与附加检查的默认值：
//   MP-37（docs/specs/model-providers.md §14.2–§14.4）：App 套件（smoke、m1–m6 的 App 测试）记进
//     test-results/v1-models-app-existing.json，回放套件（m1–m6 的回放测试）记进 test-results/v1-models-replay-existing.json。
//     m7 的 App 与回放随工作回顾删除（docs/specs/memory.md §14.4）。
//   TB-46（docs/specs/parallel-agents-taskboard.md §17.2–§17.4）：套件列表 taskboard（上面的全部，加
//     v1-models-app-settings、-switch、-session 与 v1-models-replay），App 套件记进 tb-app-existing.json；
//     回放层的 tb-replay-existing.json 依次记 "TB-46 test:unit"（npm run test:unit，模型层的单元）、回放套件、
//     "TB-46 spec-coverage"（node tests/spec-coverage.mjs --allow-missing-real，模型层的覆盖检查，按退出码 0 记通过，
//     最后跑；模型层的真实层 MP-27 本轮没有重跑，结果文件不存在时记为 pending，记忆规格 §14.4）。
//     这次运行同时写模型层 MP-37 的两个结果文件（同样的套件，记 "MP-37 <脚本名>"，规格 §17.4），在覆盖检查之前写；
//     覆盖检查读前面刚写的 v1-unit.json、v1-models-app-*.json、v1-models-replay.json 与这两个文件。
//   MEM-35（docs/specs/memory.md §14.4）：套件列表 memory：App 层记进 mem-app-existing.json：m0-smoke、m1–m6 的 App 套件、
//     v1-models-app-{settings,switch,session}、tb-build-base（TB-03 的对照构建，.tb-runs/base 不存在时才建，已有时记一条
//     通过并注明没有重建；它不打印 PASS 行）、tb-app-*；回放层记进 mem-replay-existing.json，依次为 test:unit、
//     test:tb-unit、m1–m6 的回放、v1-models-replay、tb-replay。套件跑完后先写 MP-37 的两个结果文件，再跑
//     node tests/spec-coverage.mjs --allow-missing-real（记 "MEM-35 spec-coverage"，也作为 TB-46 的 "spec-coverage"），
//     然后写 TB-46 的两个结果文件（tb-app-existing.json、tb-replay-existing.json，每条记 "TB-46 <脚本名>"），
//     最后跑 node tests/spec-coverage.mjs --spec taskboard --allow-missing-real（记 "MEM-35 spec-coverage-taskboard"）。
//     模型层与 TaskBoard 的真实层（MP-27；TB-04、TB-08、TB-34、TB-37、TB-45）本轮没有重跑，交付说明列为未验证。
//   MD-15（docs/specs/model-discovery.md §13.3、§13.4，照 MEM-35 的写法）：套件列表 discovery = memory 再加记忆的 App
//     套件（mem-app-prompt、-tool、-page、-enhance-a、-enhance-b、-team、-settings，与 npm 脚本 test:memory 的顺序相同）、
//     test:mem-unit 与 mem-replay。App 层记进 md-app-existing.json：memory 的 App 套件，再接记忆的 App 套件；回放层记进
//     md-replay-existing.json，依次为 test:unit、memory 的回放层（test:tb-unit、m1–m6 的回放、v1-models-replay、
//     tb-replay）、test:mem-unit、mem-replay，然后四项附加检查：node tests/spec-coverage.mjs --spec model、
//     --spec taskboard、--spec memory（都带 --allow-missing-real，各记 "MD-15 spec-coverage-<规格>"），最后
//     node tests/md-markers.mjs（新加的行里没有推迟实现的标记，记 "MD-15 md-markers"）。另写 MP-37、TB-46、MEM-35 的
//     结果文件（同样的套件，记 "<编号> <脚本名>"），各在读它的那项覆盖检查之前写：MP-37 在 --spec model 之前，TB-46
//     在 --spec taskboard 之前，MEM-35 在 --spec memory 之前。TB-46、MEM-35 的那一项 "spec-coverage" 是模型层的覆盖检查：
//     MD-15 的 spec-coverage-model 带 sameAs，结果同时记在 spec-coverage 的名字下，另写时按名字找到它。
//     模型层、TaskBoard 与记忆的真实层（MP-27；TB-04、TB-08、TB-34、TB-37、TB-45；MEM-05、MEM-10、MEM-22、MEM-34）
//     本轮没有重跑，交付说明列为未验证。
//   AG-11（docs/specs/customize-agents.md §9.2）：套件列表 agents，只有 Customize › Agents 改到的现有界面套件：App 层
//     先做 TB-03 的对照构建（tb-build-base，tb-app-roles 的 TB-03 要用），再跑 tb-app-roles、tb-app-models、
//     m6-app-tools、m6-app-settings、mem-app-settings，记进 ag-app-existing.json；回放层 m6-replay 记进
//     ag-replay-existing.json。不跑单元测试与覆盖检查（单元层由 npm run test:ag-unit，覆盖检查是 npm run test:agents 的
//     最后一步）。
// 各套件自己的结果文件照旧写（m1-app.json 等）；这里另把每个套件的输出存到 test-results/<日志目录>/<脚本名>.log
// （MP-37 为 v1-models-existing，TB-46 为 tb-existing，MEM-35 为 mem-existing，MD-15 为 md-existing；脚本名里的 ":"
// 换成 "-"），失败时检查的细节里带它打印的 FAIL 行（md-markers 另带命中的行）。
// 套件要求 out/ 里已是最新构建（npm run test:v1-models、test:memory、test:discovery 先 electron-vite build，这里不构建；
// tb-build-base 只建 .tb-runs/base 的对照版）。现有套件用固定端口（4319–4371、4500–4559、4600–4799；一键拉取模型的
// 套件用 4800–4899），不要和别的现有套件同时跑。
// 用法（在 app/ 下）：
//   node tests/ui/v1-models-existing.mjs [--id MP-37|TB-46|MEM-35|MD-15|AG-11] [--only m0-smoke,m1-replay]
//     [--exe <Mori.exe>] [--app-file <名字.json>] [--replay-file <名字.json>]
//     [--suites models|taskboard|memory|discovery|agents] [--with-unit] [--with-coverage]
// --app-file、--replay-file、--suites 换掉编号的默认值；--with-unit、--with-coverage 加上 test:unit 与模型层的覆盖检查
// （TB-46、MEM-35、MD-15 默认带；MD-15 的模型层覆盖检查即 spec-coverage-model）。
// --only 用脚本名或附加检查的名字（例如 --id MD-15 --only md-markers 只跑标记检查）。
// --exe：只跑 App 套件（回放与附加检查不经过构建），把 --exe 传给支持它的套件，App 层的结果文件名在 .json 前加
// -packaged（v1-models-app-existing-packaged.json、tb-app-existing-packaged.json、mem-app-existing-packaged.json、
// md-app-existing-packaged.json）；另写的编号同样只写 App 层（加 -packaged）。
// m1-layout.mjs 是检查库、单独运行什么也不做：它的布局检查（含 §14.4 的 Models 分节测量）在 m1-replay 的 layout 一项里跑，
// 随 m1-replay 记一条。退出码为 0 但一条 PASS 都没有的套件记为失败（没跑任何检查不能算通过）；覆盖检查与对照构建不打印
// PASS 行，只看退出码。
// --only 只跑一部分时结果写到部分结果文件，不写上面的文件，也不另写别的编号：MP-37 为
// v1-models-existing-partial-app(-packaged).json / -partial-replay.json，TB-46 为
// tb-partial-existing-app(-packaged).json / tb-partial-existing-replay.json，MEM-35 为
// mem-partial-existing-app(-packaged).json / mem-partial-existing-replay.json，MD-15 为
// md-partial-existing-app(-packaged).json / md-partial-existing-replay.json。
// 覆盖检查（tests/spec-coverage.mjs）只认跑全了的结果，一部分套件通过不能算 MP-37、TB-46、MEM-35 或 MD-15 通过。
// 参数不认识时退出码为 2。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
 * @param extra 覆盖默认字段（needsPass、what、skip：返回不跑的理由或 null）
 */
const suite = (name, takesExe, extra = {}) => ({ name, takesExe, command: [join(appRoot, 'tests/ui', `${name}.mjs`)],
  needsPass: true, failLine: FAIL_LINE, what: 'the existing suite passes', ...extra });

/** 模型层 §14.4 的 App 套件（npm 脚本 smoke、test:app、test:m2-app … test:m6-app；m7 已删除，记忆规格 §14.4） */
const APP_SUITES = [
  suite('m0-smoke', true), suite('m1-app', true), suite('m2-app', true), suite('m3-app', true), suite('m4-app', true),
  suite('m5-app', true), suite('m6-app-settings', true), suite('m6-app-tools', true), suite('m6-app-slash', true),
  suite('m6-app-row', true), suite('m6-app-mcp-shared', true),
];
/** 模型层 §14.4 的回放套件（test:replay、test:m2-replay … test:m6-replay） */
const REPLAY_SUITES = ['m1-replay', 'm2-replay', 'm3-replay', 'm4-replay', 'm5-replay', 'm6-replay']
  .map((name) => suite(name, false));
/** 模型层自己的 App 套件 */
const V1_APP_SUITES = ['v1-models-app-settings', 'v1-models-app-switch', 'v1-models-app-session']
  .map((name) => suite(name, true));
/** TaskBoard 的 App 套件（与 npm 脚本 test:taskboard 的顺序相同） */
const TB_APP_SUITES = ['tb-app-roles', 'tb-app-modes', 'tb-app-flow', 'tb-app-ask', 'tb-app-handoff', 'tb-app-sched',
  'tb-app-models', 'tb-app-stop', 'tb-app-misc'].map((name) => suite(name, true));
/** TB-03 的对照构建：.tb-runs/base 已有时不重建（记一条通过并注明）；它不打印 PASS 行，只看退出码 */
const TB_BASE = suite('tb-build-base', false, { needsPass: false, failLine: /failed with exit code/,
  what: 'the TB-03 base build (.tb-runs/base) is there',
  skip: () => (existsSync(join(appRoot, '.tb-runs', 'base', 'out', 'main', 'index.js'))
    ? 'not rebuilt: .tb-runs/base already exists' : null) });

/** 附加检查：模型层的单元测试（经 npm，命令行与 package.json 的 test:unit 一致） */
const UNIT_CHECK = { name: 'test:unit', takesExe: false, shell: 'npm run test:unit', needsPass: true,
  failLine: FAIL_LINE, what: 'the model unit tests pass' };
/** MEM-35：TaskBoard 的单元测试（package.json 的 test:tb-unit） */
const TB_UNIT_CHECK = { name: 'test:tb-unit', takesExe: false, shell: 'npm run test:tb-unit', needsPass: true,
  failLine: FAIL_LINE, what: 'the TaskBoard unit tests pass' };
/**
 * 附加检查：模型层的覆盖检查（不打印 PASS 行，只看退出码；失败时细节里带它列出的缺口，缺口行以两个空格和编号开头）。
 * 带 --allow-missing-real：模型层的真实层（MP-27）本轮没有重跑（记忆规格 §14.4）
 */
const COVERAGE_CHECK = { name: 'spec-coverage', takesExe: false,
  command: [join(appRoot, 'tests/spec-coverage.mjs'), '--allow-missing-real'], needsPass: false,
  failLine: /^ {2}MP-\d+ /, what: 'the model coverage check exits 0' };
/** MEM-35 的最后一项：TaskBoard 的覆盖检查（真实层 TB-04、TB-08、TB-34、TB-37、TB-45 本轮没有重跑） */
const TB_COVERAGE_CHECK = { name: 'spec-coverage-taskboard', takesExe: false,
  command: [join(appRoot, 'tests/spec-coverage.mjs'), '--spec', 'taskboard', '--allow-missing-real'],
  needsPass: false, failLine: /^ {2}TB-\d+ /, what: 'the TaskBoard coverage check exits 0' };
/** 记忆的 App 套件（与 npm 脚本 test:memory 的顺序相同） */
const MEM_APP_SUITES = ['mem-app-prompt', 'mem-app-tool', 'mem-app-page', 'mem-app-enhance-a', 'mem-app-enhance-b',
  'mem-app-team', 'mem-app-settings'].map((name) => suite(name, true));
/** MD-15：记忆的单元测试（package.json 的 test:mem-unit） */
const MEM_UNIT_CHECK = { name: 'test:mem-unit', takesExe: false, shell: 'npm run test:mem-unit', needsPass: true,
  failLine: FAIL_LINE, what: 'the memory unit tests pass' };
/**
 * MD-15 的模型层覆盖检查：与 COVERAGE_CHECK 是同一项检查（--spec model 即默认规格），记 "MD-15 spec-coverage-model"。
 * sameAs：结果同时记在 COVERAGE_CHECK 的名字下，另写 TB-46、MEM-35 的结果文件时它们的 "spec-coverage" 一项按名字找到它
 */
const MODEL_COVERAGE_CHECK = { ...COVERAGE_CHECK, name: 'spec-coverage-model',
  command: [join(appRoot, 'tests/spec-coverage.mjs'), '--spec', 'model', '--allow-missing-real'],
  sameAs: COVERAGE_CHECK };
/** MD-15：记忆的覆盖检查（真实层 MEM-05、MEM-10、MEM-22、MEM-34 本轮没有重跑） */
const MEM_COVERAGE_CHECK = { name: 'spec-coverage-memory', takesExe: false,
  command: [join(appRoot, 'tests/spec-coverage.mjs'), '--spec', 'memory', '--allow-missing-real'],
  needsPass: false, failLine: /^ {2}MEM-\d+ /, what: 'the memory coverage check exits 0' };
/**
 * MD-15 的最后一项：这次工作新加的行里没有推迟实现的标记（tests/md-markers.mjs，规格 §13.3）。它打印 PASS / FAIL 行，
 * 命中的行为 "<文件>:<行号>: <内容>"，失败时细节里带它们
 */
const MARKER_CHECK = { name: 'md-markers', takesExe: false, command: [join(appRoot, 'tests/md-markers.mjs')],
  needsPass: true, failLine: /^FAIL\b|^app\/\S+:\d+: /, what: 'no deferral markers in the lines this work adds' };

/** 记忆规格 §14.4 的 MEM-35 的套件列表（discovery 在它后面再加记忆自己的套件） */
const MEMORY_LISTS = {
  app: [...APP_SUITES, ...V1_APP_SUITES, TB_BASE, ...TB_APP_SUITES],
  replay: [TB_UNIT_CHECK, ...REPLAY_SUITES, suite('v1-models-replay', false), suite('tb-replay', false)],
};

/**
 * @brief 套件列表：名字 → { app, replay }。
 *        models 为模型层 §14.4 的套件；taskboard 为 TaskBoard §17.4 的 TB-46：再加模型层的 App 与回放套件；
 *        memory 为记忆规格 §14.4 的 MEM-35：再加 TB-03 的对照构建、TaskBoard 的 App 套件、单元与回放；
 *        discovery 为一键拉取模型规格 §13.3 的 MD-15：memory 再加记忆的 App 套件、test:mem-unit 与 mem-replay。
 *        agents 为 Customize › Agents 规格 §9.2 的 AG-11：这一节改到的现有界面套件。
 */
const SUITE_LISTS = {
  models: { app: APP_SUITES, replay: REPLAY_SUITES },
  taskboard: { app: [...APP_SUITES, ...V1_APP_SUITES], replay: [...REPLAY_SUITES, suite('v1-models-replay', false)] },
  memory: MEMORY_LISTS,
  discovery: {
    app: [...MEMORY_LISTS.app, ...MEM_APP_SUITES],
    replay: [...MEMORY_LISTS.replay, MEM_UNIT_CHECK, suite('mem-replay', false)],
  },
  agents: {
    app: [TB_BASE, ...['tb-app-roles', 'tb-app-models', 'm6-app-tools', 'm6-app-settings', 'mem-app-settings']
      .map((name) => suite(name, true))],
    replay: [suite('m6-replay', false)],
  },
};

/**
 * @brief 各编号的默认值。appFile、replayFile 为跑全时的结果文件（appFile 在 --exe 时加 -packaged）；
 *        partial 为 --only 时结果文件名的前缀（后接 app(-packaged).json、replay.json）；logDir 为日志目录名
 *        （--exe 时加 -packaged）；suites 为 SUITE_LISTS 的名字；withUnit 为回放层是否先跑 test:unit；
 *        tail 为回放层最后的附加检查；also 为这次运行另写结果文件的编号：{ id, before }，在 before 这一项之前写
 *        （这一项没跑时在最后写；--exe 时在 App 套件之后写）。
 */
const PRESETS = {
  'MP-37': { appFile: 'v1-models-app-existing.json', replayFile: 'v1-models-replay-existing.json',
    partial: 'v1-models-existing-partial-', logDir: 'v1-models-existing', suites: 'models', withUnit: false,
    tail: [], also: [] },
  'TB-46': { appFile: 'tb-app-existing.json', replayFile: 'tb-replay-existing.json',
    partial: 'tb-partial-existing-', logDir: 'tb-existing', suites: 'taskboard', withUnit: true,
    tail: [COVERAGE_CHECK], also: [{ id: 'MP-37', before: COVERAGE_CHECK }] },
  'MEM-35': { appFile: 'mem-app-existing.json', replayFile: 'mem-replay-existing.json',
    partial: 'mem-partial-existing-', logDir: 'mem-existing', suites: 'memory', withUnit: true,
    tail: [COVERAGE_CHECK, TB_COVERAGE_CHECK],
    also: [{ id: 'MP-37', before: COVERAGE_CHECK }, { id: 'TB-46', before: TB_COVERAGE_CHECK }] },
  'MD-15': { appFile: 'md-app-existing.json', replayFile: 'md-replay-existing.json',
    partial: 'md-partial-existing-', logDir: 'md-existing', suites: 'discovery', withUnit: true,
    tail: [MODEL_COVERAGE_CHECK, TB_COVERAGE_CHECK, MEM_COVERAGE_CHECK, MARKER_CHECK],
    also: [{ id: 'MP-37', before: MODEL_COVERAGE_CHECK }, { id: 'TB-46', before: TB_COVERAGE_CHECK },
      { id: 'MEM-35', before: MEM_COVERAGE_CHECK }] },
  'AG-11': { appFile: 'ag-app-existing.json', replayFile: 'ag-replay-existing.json',
    partial: 'ag-partial-existing-', logDir: 'ag-existing', suites: 'agents', withUnit: false, tail: [], also: [] },
};

/** @brief 参数不认识时打印原因并以退出码 2 结束。 */
function usageError(message) {
  console.error(`[v1-models-existing] ${message}`);
  process.exit(2);
}

/** @brief 一个编号回放层的全部项：先 test:unit（withUnit 时），再套件列表的回放，最后 tail。 */
const replayEntriesOf = (withUnit, lists, tail) => [...(withUnit ? [UNIT_CHECK] : []), ...lists.replay, ...tail];

/**
 * @brief 解析命令行：编号的默认值加上各参数。
 * @return { id, preset, only, exePath, lists, logName, logDir, appFile, replayFile, withUnit, tail }；
 *         logName 为 test-results/ 下的日志目录名，appFile、replayFile 为这次实际写的结果文件
 */
function readOptions() {
  const id = arg('id') ?? 'MP-37';
  if (!Object.hasOwn(PRESETS, id)) usageError(`unknown --id "${id}" (expected ${Object.keys(PRESETS).join(', ')})`);
  const preset = PRESETS[id];
  const listName = arg('suites') ?? preset.suites;
  if (!Object.hasOwn(SUITE_LISTS, listName)) {
    usageError(`unknown --suites "${listName}" (expected ${Object.keys(SUITE_LISTS).join(', ')})`);
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
  const coverage = process.argv.includes('--with-coverage')
    && !preset.tail.some((entry) => entry === COVERAGE_CHECK || entry.sameAs === COVERAGE_CHECK);
  return {
    id, preset, only, exePath, lists: SUITE_LISTS[listName], logName, logDir: join(appRoot, 'test-results', logName),
    appFile: only ? `${preset.partial}app${suffix}.json` : appFile.replace(/\.json$/, `${suffix}.json`),
    replayFile: only ? `${preset.partial}replay.json` : replayFile,
    withUnit: preset.withUnit || process.argv.includes('--with-unit'),
    tail: [...preset.tail, ...(coverage ? [COVERAGE_CHECK] : [])],
  };
}

const options = readOptions();
mkdirSync(options.logDir, { recursive: true });

/** @brief 日志文件名：脚本名里的 ":" 在 Windows 的文件名里不能用。 */
const logFileOf = (entry) => `${entry.name.replace(/:/g, '-')}.log`;

/**
 * @brief 以子进程跑一个套件或附加检查，输出同时打到终端并存进日志。
 * @param entry suite() 或一项附加检查（UNIT_CHECK、TB_UNIT_CHECK、MEM_UNIT_CHECK、COVERAGE_CHECK、MODEL_COVERAGE_CHECK、
 *        TB_COVERAGE_CHECK、MEM_COVERAGE_CHECK、MARKER_CHECK）
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

/**
 * 每个跑过的套件的结果（按脚本名；带 sameAs 的附加检查另记在 sameAs 的名字下）：TB-46、MEM-35、MD-15 据此另写
 * 别的编号的结果文件
 */
const outcomes = new Map();

/** @brief 跑一项（skip 给出理由时不跑、记为通过并注明），返回 { ok, detail }。 */
async function runEntry(entry) {
  const { exePath } = options;
  const skipped = entry.skip?.() ?? null;
  if (skipped) return { ok: true, detail: skipped };
  console.log(`\n[v1-models-existing] ==== ${entry.name} ====`);
  const args = exePath && entry.takesExe ? ['--exe', exePath] : [];
  const note = exePath && !entry.takesExe ? 'no --exe support, ran against the dev build' : '';
  const run = await runSuite(entry, args);
  writeFileSync(join(options.logDir, logFileOf(entry)), run.output);
  const ran = !entry.needsPass || /^PASS /m.test(run.output.replace(/\x1b\[[0-9;]*m/g, ''));
  return { ok: run.code === 0 && ran,
    detail: `${ran ? '' : 'no PASS line, the suite ran no checks; '}${detailOf(entry, run, note)}` };
}

/**
 * @brief 跑一组套件，每个记一条 "<编号> <脚本名>"，写结果文件；返回是否全部通过。
 * @param before 跑每一项之前调用（在覆盖检查之前另写别的编号的结果文件）；省略时不调
 */
async function runGroup(entries, resultFile, before = () => {}) {
  const { exePath, only, id } = options;
  const recorder = createRecorder(exePath ?? 'dev build');
  const chosen = entries.filter((entry) => !only || only.includes(entry.name));
  if (chosen.length === 0) return true;
  for (const entry of chosen) {
    before(entry);
    const outcome = await runEntry(entry);
    outcomes.set(entry.name, outcome);
    if (entry.sameAs) outcomes.set(entry.sameAs.name, outcome);
    recorder.record(`${id} ${entry.name}: ${entry.what}`, outcome.ok, outcome.detail);
  }
  return recorder.write(resultFile);
}

/** 已经另写过结果文件的编号 */
const written = new Set();

/**
 * @brief 跑全时另写别的编号的结果文件（TB-46 写 MP-37，规格 §17.4；MEM-35 写 MP-37 与 TB-46，记忆规格 §14.4；
 *        MD-15 写 MP-37、TB-46 与 MEM-35，一键拉取模型规格 §13.3）：
 *        那个编号自己的套件与附加检查，用这次运行的结果，记 "<编号> <脚本名>"；--only 时不写（部分结果不能算通过）。
 *        --exe 时只写 App 层（加 -packaged）。
 */
function writeAlso(also) {
  if (options.only || written.has(also)) return;
  written.add(also);
  const preset = PRESETS[also];
  const lists = SUITE_LISTS[preset.suites];
  const suffix = options.exePath ? '-packaged' : '';
  const groups = [[lists.app, preset.appFile.replace(/\.json$/, `${suffix}.json`)]];
  if (!options.exePath) groups.push([replayEntriesOf(preset.withUnit, lists, preset.tail), preset.replayFile]);
  for (const [entries, file] of groups) {
    const recorder = createRecorder(options.exePath ?? 'dev build');
    for (const entry of entries) {
      const outcome = outcomes.get(entry.name) ?? { ok: false, detail: `${entry.name} did not run` };
      recorder.record(`${also} ${entry.name}: ${entry.what}`, outcome.ok, outcome.detail);
    }
    recorder.write(file);
  }
}

const { lists, exePath, preset } = options;
const replayEntries = replayEntriesOf(options.withUnit, lists, options.tail);
const appOk = await runGroup(lists.app, options.appFile);
if (exePath) for (const also of preset.also) writeAlso(also.id);
const replayOk = exePath ? true : await runGroup(replayEntries, options.replayFile, (entry) => {
  for (const also of preset.also) if (also.before === entry) writeAlso(also.id);
});
for (const also of preset.also) writeAlso(also.id);
process.exitCode = appOk && replayOk ? 0 : 1;
