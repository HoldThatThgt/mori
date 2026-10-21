// MP-37（docs/specs/model-providers.md §14.2、§14.3、§14.4）：现有功能不退步。依次以子进程跑 §14.4 的现有套件，
// 每个套件按退出码记一条 "MP-37 <脚本名>"：App 套件（smoke、m1–m7 的 App 测试）记进
// test-results/v1-models-app-existing.json，回放套件（m1–m7 的回放测试）记进 test-results/v1-models-replay-existing.json。
// 各套件自己的结果文件照旧写（m1-app.json 等）；这里另把每个套件的输出存到 test-results/v1-models-existing/<脚本名>.log，
// 失败时检查的细节里带它打印的 FAIL 行。
// 套件要求 out/ 里已是最新构建（npm run test:v1-models 先 electron-vite build，这里不构建）。现有套件用固定端口
// （4319–4371），不要和别的现有套件同时跑。
// 用法（在 app/ 下）：
//   node tests/ui/v1-models-existing.mjs [--only m0-smoke,m1-replay] [--exe <Mori.exe>]
// --exe：只跑 App 套件（回放不经过构建），把 --exe 传给支持它的套件，结果写到 v1-models-app-existing-packaged.json；
// m1-layout.mjs 是检查库、单独运行什么也不做：它的布局检查（含 §14.4 的 Models 分节测量）在 m1-replay 的 layout 一项里跑，
// 随 m1-replay 记 MP-37。退出码为 0 但一条 PASS 都没有的套件记为失败（没跑任何检查不能算通过）。
// --only 只跑一部分时结果写到 v1-models-existing-partial-app(-packaged).json / -partial-replay.json，不写上面两个文件：
// 覆盖检查（tests/spec-coverage.mjs）只认跑全了的结果，一部分套件通过不能算 MP-37 通过。

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine } from './lib.mjs';

const only = arg('only')?.split(',');
const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const logDir = join(appRoot, `test-results/v1-models-existing${suffix}`);
mkdirSync(logDir, { recursive: true });
/** 每个套件最长跑多久（m3、m6 的 App 套件要十几分钟） */
const SUITE_TIMEOUT_MS = 60 * 60 * 1000;

/** §14.4 的 App 套件：脚本名、是否支持 --exe（npm 脚本 smoke、test:app、test:m2-app … test:m7-app） */
const APP_SUITES = [
  ['m0-smoke', true], ['m1-app', true], ['m2-app', true], ['m3-app', true], ['m4-app', true],
  ['m5-app', true], ['m6-app-settings', true], ['m6-app-tools', true], ['m6-app-slash', true],
  ['m6-app-mcp-shared', true], ['m7-app', true],
];
/** §14.4 的回放套件（test:replay、test:m2-replay … test:m7-replay） */
const REPLAY_SUITES = ['m1-replay', 'm2-replay', 'm3-replay', 'm4-replay', 'm5-replay', 'm6-replay', 'm7-replay'];

/**
 * @brief 以子进程跑一个套件，输出同时打到终端并存进日志。
 * @return { code, output, ms }；超时时 code 为 null
 */
function runSuite(script, args) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(appRoot, 'tests/ui', `${script}.mjs`), ...args],
      { cwd: appRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const take = (chunk, stream) => {
      output += String(chunk);
      stream.write(chunk);
    };
    child.stdout.on('data', (chunk) => take(chunk, process.stdout));
    child.stderr.on('data', (chunk) => take(chunk, process.stderr));
    const timer = setTimeout(() => {
      output += `\n[v1-models-existing] ${script} timed out after ${SUITE_TIMEOUT_MS / 60000} min\n`;
      child.kill();
    }, SUITE_TIMEOUT_MS);
    child.on('error', (error) => {
      output += `\n[v1-models-existing] cannot start ${script}: ${error.message}\n`;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: signal ? null : code, output, ms: Date.now() - started });
    });
  });
}

/** @brief 细节：退出码、用时、日志位置，失败时带前几条 FAIL 行。 */
function detailOf(script, { code, output, ms }, note) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const fails = lines.filter((line) => /^(FAIL|KNOWN)\b/.test(line));
  const counts = `${lines.filter((line) => line.startsWith('PASS ')).length} PASS, ${fails.length} FAIL`;
  const head = `exit ${code ?? 'timeout'}, ${Math.round(ms / 1000)} s, ${counts}, log test-results/`
    + `v1-models-existing${suffix}/${script}.log${note ? `; ${note}` : ''}`;
  return code === 0 ? head : `${head}; ${fails.slice(0, 6).map((line) => oneLine(line, 160)).join(' | ')}`;
}

/** @brief 跑一组套件，每个记一条 "MP-37 <脚本名>"，写结果文件；返回是否全部通过。 */
async function runGroup(suites, resultFile) {
  const recorder = createRecorder(exePath ?? 'dev build');
  const chosen = suites.filter(([script]) => !only || only.includes(script));
  if (chosen.length === 0) return true;
  for (const [script, takesExe] of chosen) {
    console.log(`\n[v1-models-existing] ==== ${script} ====`);
    const args = exePath && takesExe ? ['--exe', exePath] : [];
    const note = exePath && !takesExe ? 'no --exe support, ran against the dev build' : '';
    const run = await runSuite(script, args);
    writeFileSync(join(logDir, `${script}.log`), run.output);
    const ran = /^PASS /m.test(run.output.replace(/\x1b\[[0-9;]*m/g, ''));
    recorder.record(`MP-37 ${script}: the existing suite passes`, run.code === 0 && ran,
      `${ran ? '' : 'no PASS line, the suite ran no checks; '}${detailOf(script, run, note)}`);
  }
  return recorder.write(resultFile);
}

const appFile = only ? `v1-models-existing-partial-app${suffix}.json` : `v1-models-app-existing${suffix}.json`;
const replayFile = only ? 'v1-models-existing-partial-replay.json' : 'v1-models-replay-existing.json';
const appOk = await runGroup(APP_SUITES, appFile);
const replayOk = exePath ? true : await runGroup(REPLAY_SUITES.map((script) => [script, false]), replayFile);
process.exitCode = appOk && replayOk ? 0 : 1;
