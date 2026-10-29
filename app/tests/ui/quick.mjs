// 2 分钟的快速集：负责人 2026-10-28 定的三层测试的第一层（AGENTS.md“测试分层”，docs/v1/test-strategy.md），写代码时
// 每次改动跑这一个命令（npm run test:quick）。原来的 test:min（检查、构建、八组单元）与界面快速集一个接一个跑、合起来
// 约 3.8 分钟；这里分两段同时跑：
//   1. 同时开始：静态检查（npm run check）、开发构建（electron-vite build）、回放页面（harness-page.mjs，输入没变时不重建）、
//      八组单元测试（package.json 的 test:unit … test:fs-unit，单元测试不读 out/，打包结果按进程命名，可以同时跑）；
//   2. 构建与回放页面都好了之后同时开始两条线：冒烟测试（合成端点驱动的首次设置、对话、工具卡、关窗口、后台进程崩溃），
//      与依次回放三段真实录制（任务模式、记忆工具、普通对话），各只回放一段。两条线各自的检查只看自己的进程树。
// 构建或回放页面失败时第 2 段不跑，那几项记为失败。
// 用法（在 app/ 下）：node tests/ui/quick.mjs（npm run test:quick）
// 每项的输出写到 test-results/quick/<名字>.log；任何一项失败时退出码为 1；总时间超过 2 分钟时打印 SLOW，提醒把这个集合
// 再减小（不算失败）。

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '../..');
const logDir = join(appRoot, 'test-results', 'quick');
/** 整套的时间上限（负责人定的 2 分钟） */
const LIMIT_MS = 120_000;

/** 第 1 段：静态检查、开发构建、回放页面；shell 为经 shell 跑的命令，args 为交给 node 的参数 */
const FIRST = [
  { name: 'check', shell: 'npm run check' },
  { name: 'build', shell: 'npx electron-vite build' },
  { name: 'harness', args: ['tests/ui/harness-page.mjs'] },
];
/** 界面的两条线要等的项（静态检查失败时照样跑） */
const NEEDED = ['build', 'harness'];
/** @brief 一组单元测试（package.json 的脚本名）。 */
const unitItem = (script) => ({ name: script.replace(':', '-'), shell: `npm run ${script}` });
/**
 * 第 2 段的四条线：同一条线里的项依次跑，四条线同时跑；ui 为界面的线（第 1 段的 build 或 harness 失败时不跑）。
 * 八组单元测试分两条线、按单独跑时的用时（fs 24 秒、md 18、mem 14、tb 6、unit 6、fc 5、sa 3、ag 2）分得差不多长：
 * 八组和构建一起跑时 CPU 不够，构建慢到 4 倍，TB-84 等 60 毫秒的检查也会失败
 */
const LANES = [
  { ui: true, items: [{ name: 'm0-smoke', args: ['tests/ui/m0-smoke.mjs'] }] },
  { ui: true, items: [
    { name: 'tb-replay', args: ['tests/ui/tb-replay.mjs', '--only', 'tb-team'] },
    { name: 'mem-replay', args: ['tests/ui/mem-replay.mjs', '--only', 'mem-tool'] },
    { name: 'm1-replay', args: ['tests/ui/m1-replay.mjs', '--only', 'readme'] },
  ] },
  { ui: false, items: ['test:fs-unit', 'test:mem-unit', 'test:sa-unit', 'test:ag-unit'].map(unitItem) },
  { ui: false, items: ['test:md-unit', 'test:tb-unit', 'test:unit', 'test:fc-unit'].map(unitItem) },
];

/** @brief 一项的 PASS 行数：界面套件数 PASS 行，单元测试数报告器的 “n/m unit checks passed”。 */
function passedOf(lines) {
  const counted = lines.map((line) => /^(\d+)\/\d+ unit checks passed/.exec(line)).find(Boolean);
  return counted ? Number(counted[1]) : lines.filter((line) => line.startsWith('PASS')).length;
}

/**
 * @brief 跑一项，输出写进日志文件，结束后打印一行并返回结果。
 * @return { name, code: 退出码, ms: 用时, passed: 通过的检查数, failed: FAIL 行（原文） }
 */
function runItem(item, started) {
  const begin = Date.now();
  const log = createWriteStream(join(logDir, `${item.name}.log`));
  const options = { cwd: appRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] };
  const child = item.shell ? spawn(item.shell, { ...options, shell: true })
    : spawn(process.execPath, item.args, options);
  let text = '';
  const keep = (chunk) => {
    text += chunk;
    log.write(chunk);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return new Promise((done) => {
    child.on('close', (code) => {
      log.end();
      const lines = text.split(/\r?\n/);
      const result = { name: item.name, code: code ?? 1, ms: Date.now() - begin, passed: passedOf(lines),
        failed: lines.filter((line) => line.startsWith('FAIL')) };
      const at = Math.round((Date.now() - started) / 1000);
      console.log(`${result.code === 0 ? 'PASS' : 'FAIL'} ${result.name} — ${result.passed} passed,`
        + ` ${result.failed.length} failed, exit ${result.code}, ${Math.round(result.ms / 1000)}s (done at ${at}s)`);
      for (const line of result.failed.slice(0, 10)) console.log(`  ${line.slice(0, 200)}`);
      done(result);
    });
  });
}

/** @brief 依次跑一条线里的项。 */
async function runLane(items, started) {
  const results = [];
  for (const item of items) results.push(await runItem(item, started));
  return results;
}

/** @brief 把一条线里的项记为没跑（失败）。 */
const skipLane = (items, why) => items.map((item) => {
  console.log(`FAIL ${item.name} — not run: ${why} failed`);
  return { name: item.name, code: 1, ms: 0, passed: 0, failed: [] };
});

/** @brief 第 2 段：四条线同时跑；build 或 harness 失败时界面的两条线记为没跑。 */
async function secondStage(prepared, started) {
  const failedPrep = prepared.filter((result) => result.code !== 0).map((result) => result.name);
  const lanes = LANES.map((lane) => (lane.ui && failedPrep.length ? skipLane(lane.items, failedPrep.join(', '))
    : runLane(lane.items, started)));
  return (await Promise.all(lanes)).flat();
}

mkdirSync(logDir, { recursive: true });
const started = Date.now();
const first = FIRST.map((item) => ({ item, run: runItem(item, started) }));
const prepared = await Promise.all(first.filter(({ item }) => NEEDED.includes(item.name)).map(({ run }) => run));
const [secondResults, firstResults] = await Promise.all([secondStage(prepared, started),
  Promise.all(first.map(({ run }) => run))]);
const results = [...firstResults, ...secondResults];
const total = Date.now() - started;
const failed = results.filter((r) => r.code !== 0);
console.log(`${failed.length ? 'FAIL' : 'PASS'} quick set — ${results.length - failed.length}/${results.length} passed,`
  + ` ${Math.round(total / 1000)}s; logs in ${logDir}`);
if (total > LIMIT_MS) {
  console.log(`SLOW quick set took ${Math.round(total / 1000)}s, over ${LIMIT_MS / 1000}s; make the set smaller`);
}
process.exitCode = failed.length ? 1 : 0;
