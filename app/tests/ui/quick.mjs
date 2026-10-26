// 界面快速集（AGENTS.md "测试分层"，2026-10-26 负责人定）：每次改动只跑这几项，整套不超过 2 分钟；
// 完整的界面回归只在负责人要求推送到远端之前跑。
// 两条线同时跑：一条是冒烟测试（合成端点驱动的首次设置、对话、工具卡、关窗口、后台进程崩溃），另一条依次回放
// 三段真实录制（任务模式、记忆工具、普通对话），各只回放一段。两条线各自的检查只看自己的进程树，互不影响。
// 用法：
//   node tests/ui/quick.mjs      测开发构建（先 npm run build；npm run test:quick 会先构建）
// 每项的输出写到 test-results/quick/<名字>.log；任何一项失败时退出码为 1；总时间超过 2 分钟时打印 SLOW，
// 提醒把这个集合再减小（不算失败）。

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '../..');
const logDir = join(appRoot, 'test-results', 'quick');
/** 整套的时间上限（负责人定的 2 分钟） */
const LIMIT_MS = 120_000;

/**
 * 两条线：同一条线里的项依次跑，两条线同时跑。
 * name 是日志文件名；args 是交给 node 的参数（从 app/ 起的相对路径）。
 */
const LANES = [
  [{ name: 'm0-smoke', args: ['tests/ui/m0-smoke.mjs'] }],
  [
    { name: 'tb-replay', args: ['tests/ui/tb-replay.mjs', '--only', 'tb-team'] },
    { name: 'mem-replay', args: ['tests/ui/mem-replay.mjs', '--only', 'mem-tool'] },
    { name: 'm1-replay', args: ['tests/ui/m1-replay.mjs', '--only', 'readme'] },
  ],
];

/**
 * @brief 跑一项，输出写进日志文件，结束后返回结果。
 * @return { name, code: 退出码, ms: 用时, passed: PASS 行数, failed: FAIL 行（原文） }
 */
function runItem({ name, args }) {
  const started = Date.now();
  const log = createWriteStream(join(logDir, `${name}.log`));
  const child = spawn(process.execPath, args, { cwd: appRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      done({ name, code: code ?? 1, ms: Date.now() - started, passed: lines.filter((l) => l.startsWith('PASS')).length,
        failed: lines.filter((l) => l.startsWith('FAIL')) });
    });
  });
}

/** @brief 依次跑一条线里的项，每项结束时打印一行。 */
async function runLane(items) {
  const results = [];
  for (const item of items) {
    const result = await runItem(item);
    const status = result.code === 0 ? 'PASS' : 'FAIL';
    console.log(`${status} ${result.name} — ${result.passed} passed, ${result.failed.length} failed,`
      + ` exit ${result.code}, ${Math.round(result.ms / 1000)}s`);
    for (const line of result.failed) console.log(`  ${line.slice(0, 200)}`);
    results.push(result);
  }
  return results;
}

mkdirSync(logDir, { recursive: true });
const started = Date.now();
const results = (await Promise.all(LANES.map(runLane))).flat();
const total = Date.now() - started;
const failed = results.filter((r) => r.code !== 0);
console.log(`${failed.length ? 'FAIL' : 'PASS'} quick set — ${results.length - failed.length}/${results.length} passed,`
  + ` ${Math.round(total / 1000)}s; logs in ${logDir}`);
if (total > LIMIT_MS) {
  console.log(`SLOW quick set took ${Math.round(total / 1000)}s, over ${LIMIT_MS / 1000}s; make the set smaller`);
}
process.exit(failed.length ? 1 : 0);
