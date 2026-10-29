// 三层测试的界面套件运行器（负责人 2026-10-28 定，AGENTS.md“测试分层”，docs/v1/test-strategy.md）：
//   --tier push --family <组>[,<组>]  第二层：功能做完、推送前。先跑 npm run test:quick（2 分钟），再用这里跑这个功能
//                                    自己那组的套件，放进 18 分钟（run-plan.mjs 的 planPush 挑，放不下的留给第三层）；
//   --tier publish                    第三层：发版前。全部组的套件各跑一次，结果还算数的（戳对得上、通过）不重跑；
//   --suites a,b                      只跑这几个（不管结果算不算数）。
// 组名：v0（m0–m6）、model、taskboard、memory、discovery、subagent、agents、finish、filesystem（同 spec-coverage 的
// --spec）。--rerun：第三层也重跑结果还算数的；--budget <分钟>：换掉第二层的 18 分钟；--dry-run：只打印计划。
// 跑之前：有 App 套件而 out/ 比 src 旧时先 electron-vite build；有回放时先建回放页面（harness-page.mjs）；
// 要对照构建的套件（tb-app-roles）在 .tb-runs/base 没有时先跑 tb-build-base。套件一个接一个跑（固定端口，见
// v1-models-existing.mjs），输出同时打到终端并存进 test-results/run/<名字>.log；每跑完一个把实测秒数写回
// tests/suite-seconds.json（提交它，下次的计划按它估），跑完写 test-results/run-summary.json。
// 退出码：计划里的套件都通过、结果算数为 0，否则为 1；参数不认识为 2。

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SECONDS, familiesOf, planAll, planPush, PUSH_BUDGET_MINUTES, SETUP_FOR } from './run-plan.mjs';
import { appRoot, buildIsCurrent, freshness, layerOf } from './stamp.mjs';

const SECONDS_FILE = join(appRoot, 'tests', 'suite-seconds.json');
const logDir = join(appRoot, 'test-results', 'run');

/** @brief 参数不认识时打印原因并以退出码 2 结束。 */
function usageError(message) {
  console.error(`[run] ${message}`);
  process.exit(2);
}

/** @brief 命令行里一个参数的值（--flag value）。 */
const optionOf = (flag) => {
  const at = process.argv.indexOf(`--${flag}`);
  return at >= 0 ? process.argv[at + 1] ?? null : null;
};

/** @brief 解析命令行，返回 { tier, names（要考虑的套件）, budgetSeconds, rerun, dryRun }。 */
function readOptions(families) {
  const tier = optionOf('tier');
  const suites = optionOf('suites')?.split(',') ?? null;
  const wanted = optionOf('family')?.split(',') ?? [];
  if (!suites && !['push', 'publish'].includes(tier)) usageError('pass --tier push|publish or --suites a,b');
  if (tier === 'push' && wanted.length === 0) usageError(`--tier push needs --family (${[...families.keys()]})`);
  for (const family of wanted) if (!families.has(family)) usageError(`unknown family "${family}"`);
  const all = [...new Set([...families.values()].flat())];
  for (const name of suites ?? []) if (!all.includes(name)) usageError(`"${name}" is not a suite in package.json`);
  const names = suites ?? (tier === 'push' ? [...new Set(wanted.flatMap((family) => families.get(family)))] : all);
  const budget = Number(optionOf('budget') ?? PUSH_BUDGET_MINUTES);
  if (!(budget > 0)) usageError('--budget must be a number of minutes');
  return { tier: suites ? 'suites' : tier, names, budgetSeconds: budget * 60,
    rerun: process.argv.includes('--rerun') || Boolean(suites), dryRun: process.argv.includes('--dry-run') };
}

/** @brief 实测秒数（tests/suite-seconds.json）；文件不在时为空。 */
const readSeconds = () => (existsSync(SECONDS_FILE) ? JSON.parse(readFileSync(SECONDS_FILE, 'utf8')) : {});

/** @brief 一个套件的候选项：层、估计秒数（estimated：没有实测）、结果算不算数。 */
function candidateOf(name, seconds) {
  const state = freshness(name);
  return { name, layer: layerOf(name), seconds: seconds[name] ?? DEFAULT_SECONDS, estimated: !(name in seconds),
    fresh: state.fresh, reason: state.reason, at: state.at };
}

/** @brief 打印计划：要跑的、结果还算数不跑的、放不下留给第三层的。 */
function printPlan(plan, tier) {
  const line = (c) => `  ${c.name} (${c.seconds}s${c.estimated ? ' estimated' : ''}${c.reason ? `; ${c.reason}` : ''})`;
  console.log(`[run] ${tier}: ${plan.run.length} to run, about ${Math.round(plan.seconds / 60)} min`);
  for (const c of plan.run) console.log(line(c));
  if (plan.fresh.length) console.log(`[run] still valid, not run: ${plan.fresh.map((c) => c.name).join(', ')}`);
  if (plan.deferred.length) console.log('[run] does not fit, left for the publish run:');
  for (const c of plan.deferred) console.log(line(c));
}

/**
 * @brief 以子进程跑一条命令，输出同时打到终端并存进日志。
 * @param name 日志文件名（不带 .log）
 * @param command 经 shell 跑的命令行
 * @return { code, ms }
 */
function runLogged(name, command) {
  const started = Date.now();
  const log = createWriteStream(join(logDir, `${name}.log`));
  const child = spawn(command, { cwd: appRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  const take = (stream) => (chunk) => {
    log.write(chunk);
    stream.write(chunk);
  };
  child.stdout.on('data', take(process.stdout));
  child.stderr.on('data', take(process.stderr));
  return new Promise((done) => {
    child.on('error', (error) => console.error(`[run] cannot start ${command}: ${error.message}`));
    child.on('close', (code) => {
      log.end();
      done({ code: code ?? 1, ms: Date.now() - started });
    });
  });
}

/** @brief 跑套件之前的准备（见文件开头）；失败时返回原因，否则为 null。 */
async function prepare(run) {
  if (run.some((c) => c.layer !== 'replay') && !buildIsCurrent()) {
    console.log('[run] out/ is older than src; building');
    if ((await runLogged('build', 'npx electron-vite build')).code !== 0) return 'electron-vite build failed';
  }
  if (run.some((c) => c.layer === 'replay')
    && (await runLogged('harness', 'node tests/ui/harness-page.mjs')).code !== 0) return 'harness build failed';
  for (const setup of new Set(run.map((c) => SETUP_FOR[c.name]).filter(Boolean))) {
    if (existsSync(join(appRoot, '.tb-runs', 'base', 'out', 'main', 'index.js'))) continue;
    if ((await runLogged(setup, `node tests/ui/${setup}.mjs`)).code !== 0) return `${setup} failed`;
  }
  return null;
}

/** @brief 依次跑计划里的套件，每个跑完写回实测秒数，返回每个的结果。 */
async function runSuites(run) {
  const outcomes = [];
  for (const candidate of run) {
    console.log(`\n[run] ==== ${candidate.name} ====`);
    const { code, ms } = await runLogged(candidate.name, `node tests/ui/${candidate.name}.mjs`);
    const state = freshness(candidate.name);
    const seconds = readSeconds();
    seconds[candidate.name] = Math.round(ms / 1000);
    writeFileSync(SECONDS_FILE, `${JSON.stringify(Object.fromEntries(Object.entries(seconds).sort()), null, 2)}\n`);
    outcomes.push({ name: candidate.name, code, seconds: Math.round(ms / 1000), ok: code === 0 && state.fresh,
      reason: state.reason, passed: state.passed, failed: state.failed });
  }
  return outcomes;
}

/** @brief 打印并写 test-results/run-summary.json，返回是否全部通过。 */
function summarize(tier, plan, outcomes) {
  console.log(`\n[run] ${tier} summary`);
  for (const o of outcomes) {
    console.log(`${o.ok ? 'PASS' : 'FAIL'} ${o.name} — ${o.passed} passed, ${o.failed} failed, exit ${o.code},`
      + ` ${o.seconds}s${o.ok ? '' : `; ${o.reason ?? 'exit code'}`}`);
  }
  const deferred = plan.deferred.map((c) => c.name);
  if (deferred.length) console.log(`[run] left for the publish run: ${deferred.join(', ')}`);
  writeFileSync(join(appRoot, 'test-results', 'run-summary.json'), `${JSON.stringify({ tier,
    at: new Date().toISOString(), outcomes, fresh: plan.fresh.map((c) => c.name), deferred }, null, 2)}\n`);
  return outcomes.every((o) => o.ok);
}

const families = familiesOf(JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')).scripts);
const options = readOptions(families);
const seconds = readSeconds();
const candidates = options.names.map((name) => candidateOf(name, seconds));
const plan = options.tier === 'push' ? planPush(candidates, options.budgetSeconds)
  : planAll(candidates, options.rerun);
printPlan(plan, options.tier);
if (!options.dryRun) {
  mkdirSync(logDir, { recursive: true });
  const failure = await prepare(plan.run);
  if (failure) {
    console.error(`[run] ${failure}; no suite ran`);
    process.exitCode = 1;
  } else {
    process.exitCode = summarize(options.tier, plan, await runSuites(plan.run)) ? 0 : 1;
  }
}
