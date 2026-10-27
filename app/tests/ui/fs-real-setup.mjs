// 文件系统规格真实模型一层（docs/specs/file-system.md §19.1“真实”一行；§19.2 FS-21、FS-40、FS-54、FS-55、FS-67、FS-82、
// FS-93、FS-113、FS-114）的共用准备：tests/ui/fs-real.mjs 与它的场景模块从这里取上下文（createRealContext）与工具。
// - 命令行：--source <数据目录>、--repo <第二个 git 仓库>（FS-21）、--only <步骤名或 FS 编号，逗号分隔>、--exe <Mori.exe>。
// - key 方式（不给 --source，FS_REAL_DEEPSEEK_KEY 与 FS_REAL_GLM_KEY 都有值；地址 FS_REAL_DEEPSEEK_URL、FS_REAL_GLM_URL
//   没给时同 v1-real-helpers.mjs 的 KEY_MODE_URLS）：这个模块一被 import 就把这几个变量读进内存并从 process.env 删掉，
//   之后启动的 Mori、git 与别的子进程都拿不到。key 只留在这个模块的私有变量 keyEnv 里（不放进 ctx：ctx 的字段可能被
//   写进 detail），只经 v1-real-helpers.mjs 的 typeKey 输进 Mori 自己的密码框（输之前核对框的 type 是 password）。
//   DEBUG 里有 pw:* 或设了 PWDEBUG 时不跑（Playwright 的调试日志会打印填进输入框的值）。
//   只经界面建一个新的数据目录：首次启动表单接 DeepSeek（firstRunDeepSeek：只勾文档的一个模型、Public、Test
//   connection、等探针），重新打开后设置 → Models → Add provider 接 GLM（addProviderUi + chooseGlm：GLM-5.3、Public），
//   等它的探针跑完；之后把这个目录当作 --source 的数据目录。
// - 别的真实套件的 key（MD_REAL_*、MP_REAL_*，负责人推送前在同一个 shell 里跑全部真实套件）与名字像 API key 的环境变量
//   同样在 import 时读出并删掉：Mori 的 bash 与 PowerShell 工具继承它的环境，模型写的脚本若打印环境，key 就会进工具
//   结果、发给模型、写进会话文件。它们的值只用来换成 ***、查明文，不输进 Mori。
// - --source 方式：负责人在 Mori 里保存过 DeepSeek 与 GLM（各有 key）的数据目录；只看键名（mem-real-helpers.mjs
//   checkSource），从不读、不打印、不解密 key，从不写这个目录。
// - 两种方式之后相同（synthetic test setup，tb-real-helpers.mjs prepareRealData）：复制数据目录（只复制加密的
//   credentials.json、Local State 与模型配置、档案、pi 设置），分组 [DeepSeek, GLM] 为默认范围，两个提供商的地址改指
//   本机 PROXY_PORT 上的记录代理 http://127.0.0.1:<端口>/p/<提供商 id>（档案跟着改地址，不重新探测），读回来核对。
//   代理把请求原样转发到真实地址，只记请求体（对话请求的 system、工具、消息），不看、不记请求头（key 在请求头里）。
//   2026-10-26 起没有网络区域，临时项目不用授权公网。Mori 的数据目录是复制出的目录（MORI_USER_DATA），快照
//   目录在它旁边（lib.mjs snapshotsDirFor，MORI_SNAPSHOTS_DIR）；启动后先 away.set { timeout: 'never' }，场景要你不在
//   时用 { awayMs }（MORI_AWAY_TIMEOUT_MS）启动并设一档非 Never 的时长。
// - 步骤：每个步骤有时限（STEP_MS，第一次启动另加 PROBE_MS）；出错或超时时记失败、截图、关掉 Mori，下一个步骤从新
//   启动的 Mori 开始；超时的步骤在 Mori 关掉之后仍停不下时不再跑之后的步骤。页面报错按步骤记（只算这个步骤里的），
//   记录代理的上游出错（网络，不是程序保证的事）写进说明。
// - 写出的一切（检查的名字、detail、note、结果文件、fixture、日志、没接住的报错）先把 key 换成 ***，换掉过的地方记下来
//   由最后的 key 核对报出；截图之前读窗口的文字与输入框的值（密码框除外），出现 key 或读不出时不截；关掉 Mori 之前再读
//   一次。知道 key 时（key 方式，或环境里有别的 key）最后一条检查核对窗口的文字、Mori 的输出、Mori 发给模型的请求、
//   这次的结果与 fixture、这次用过的数据目录、快照目录与临时项目里（加密的 credentials.json 之外）都没有 key 的明文。
//   进程意外结束或按 Ctrl+C 时也先删掉 credentials.json 的副本、结束 Mori。
// - 页面里的录制器（格式同 m2-record.mjs、md-record.mjs）：recBegin 与 saveFixture 之间记下录制器自己经 window.mori
//   发的命令与结果和后台进程转发的全部事件（{ t, command } / { t, result } / { t, envelope }，t 从 recBegin 起算）。
//   名字是 §19.1 的三份之一、场景核对通过（saveFixture 的 problems 为空，recBegin 之后记的检查都通过）、步骤里没有
//   出错的命令、也不含 key 时写到 tests/fixtures/filesystem/<名字>.json，否则写到 test-results/fs-real/<名字>.rejected.json。
// - ctx 与 fs-helpers.mjs、fs-away-helpers.mjs、tb-helpers.mjs 用的 ctx 同形（app、page、pageErrors、appLog、userData、
//   snapshots、env、exePath、projectTabs、ep.proxy.captures 的 { t, chat, body }），场景模块可以直接用那些工具（截图除外：
//   用这里的 shotReal，它先查窗口里有没有 key）。
// 只读页面和磁盘、发界面操作；不改 Mori 的源码。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setAwayTimeout } from './fs-away-helpers.mjs';
import { git, gitRun, makeProject } from './fs-git-helpers.mjs';
import { identityOf, poll, reloadFsUi, startFsApp } from './fs-helpers.mjs';
import { appRoot, arg, oneLine, snapshotsDirFor } from './lib.mjs';
import { findSecrets, installRecorder, localDate, redactor, waitProbed } from './md-real-helpers.mjs';
import { checkSource } from './mem-real-helpers.mjs';
import { contentText } from './tb-helpers.mjs';
import { prepareRealData, refOf, TB_GROUP } from './tb-real-helpers.mjs';
import {
  addProviderUi, chooseGlm, firstRunDeepSeek, firstRunProblems, glmAddProblems, KEY_MODE_URLS, openModelsSettings,
  PROBE_MS, providerBrief, takeEnvSecret, waitProfiles,
} from './v1-real-helpers.mjs';

/** key 方式的 key 的环境变量（两个都要有值） */
export const KEY_VARS = Object.freeze({ deepseek: 'FS_REAL_DEEPSEEK_KEY', glm: 'FS_REAL_GLM_KEY' });
/** key 方式的地址的环境变量与没给时的地址（共用的 KEY_MODE_URLS） */
export const URL_VARS = Object.freeze({ deepseek: ['FS_REAL_DEEPSEEK_URL', KEY_MODE_URLS.deepseek],
  glm: ['FS_REAL_GLM_URL', KEY_MODE_URLS.glm] });
/**
 * 别的真实套件的 key 的环境变量（md-real.mjs、v1-models-real.mjs；负责人推送前在同一个 shell 里跑全部真实套件时
 * 一起设）：同样读出并删掉，值只用来换成 ***、查明文
 */
export const OTHER_KEY_VARS = Object.freeze(['MD_REAL_DEEPSEEK_KEY', 'MD_REAL_GLM_KEY', 'MD_REAL_OPENROUTER_KEY',
  'MP_REAL_DEEPSEEK_KEY', 'MP_REAL_GLM_KEY', 'MP_REAL_OPENROUTER_KEY']);
/** 名字像 API key 的别的环境变量（同样读出并删掉：模型在临时项目里跑的命令能读到 Mori 的环境） */
const KEY_LIKE = /(_API_KEY|_REAL_[A-Z0-9_]*KEY)$/i;
/** 别的 key 至少这么长才当成要换掉的明文（太短的值会把普通文字也换成 ***） */
const MIN_SECRET = 8;
/** Playwright 的调试日志（DEBUG 里的 pw:* 或 *）会打印填进输入框的值：key 方式下不跑 */
const PW_DEBUG = /(^|[,\s])(pw:|\*)/;
/** 记录代理的端口（文件系统的真实层用 5016；fs-app 套件用 5000–5015，文件系统共用 5000–5019） */
export const PROXY_PORT = 5016;
/** 默认范围的分组 id（tb-real-helpers.mjs prepareRealData 建的） */
export const REAL_GROUP = TB_GROUP;
/** 回放 fixture 的目录（tests/ui/harness/main.jsx 加载它，§19.1） */
export const FIXTURE_DIR = join(appRoot, 'tests/fixtures/filesystem');
/**
 * 回放 fixture 只有这三份（§19.1）；harness/main.jsx 按文件名索引全部录制，名字与别处重复时每个回放套件都打不开，
 * 所以别的名字只写到 REJECTED_DIR
 */
export const FIXTURE_NAMES = Object.freeze(['work-scratch', 'full-outside', 'away-reminder']);
/** 核对不通过或含 key 的录制写到这里（<名字>.rejected.json） */
export const REJECTED_DIR = join(appRoot, 'test-results/fs-real');
/** 准备与收尾那几条检查的编号（FS-114：用你的数据目录跑 fs-real.mjs，录下回放 fixture） */
export const SETUP_ID = 'FS-114';
/** FS-114 之外有真实一层的编号（§19.1“真实”一行）：fixture 覆盖到它们时，录制的检查也按它们各记一条 */
export const REAL_IDS = Object.freeze(['FS-21', 'FS-40', 'FS-54', 'FS-55', 'FS-67', 'FS-82', 'FS-93', 'FS-113']);
/** 前提没满足时最多跑几次（同 mem-real.mjs、tb-real.mjs） */
export const ATTEMPTS = 3;
/** 一个步骤默认最多跑多久（步骤的 timeoutMs 可以改；第一次启动另加 PROBE_MS 等探针） */
export const STEP_MS = 30 * 60 * 1000;
/** 步骤超时、Mori 关掉之后最多等它的代码停下多久（停不下时不再跑之后的步骤） */
const SETTLE_MS = 60000;
/** 读窗口文字的时限（渲染进程卡住时当成读不出） */
const READ_MS = 5000;
/** 带值的参数（给了参数却没有值时不跑） */
const VALUE_FLAGS = ['source', 'repo', 'only', 'exe'];
/** fixture 里出现 key 时的问题（写之前已换成 ***） */
const LEAKED = 'an API key appears in the recording (replaced by *** before writing)';
/** 结果文件里 detail 与 note 最多保留的字符数（先换掉 key 再截短） */
const DETAIL_MAX = 4000;
/** 关掉 Mori 最多等多久（有序关闭后台进程；超时时结束主进程，不留进程） */
const CLOSE_MS = 20000;
/** 步骤超时的标记（within 的 fallback） */
const TIMED_OUT = Symbol('timed out');

// ---------- 时限 ----------

/**
 * @brief promise 与时限赛跑：ms 毫秒内结束时取它的结果，否则取 fallback；计时器随即清掉（不拖住进程退出）。
 *        超时之后 promise 照样在跑，调用方决定怎么处理它。
 */
export async function within(promise, ms, fallback) {
  let timer = null;
  const limit = new Promise((done) => {
    timer = setTimeout(() => done(fallback), ms);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- key 与写出的文字 ----------

/**
 * @brief 读出 key 方式的环境变量并立即从 process.env 删掉（这个模块被 import 时执行一次；之后启动的 Mori、git 与
 *        别的子进程都拿不到）。key 只留在返回值里，不打印。
 * @return { keys: { deepseek, glm }（没有值的为 null）, urls: { deepseek, glm } }
 */
function takeKeyEnv() {
  const keys = Object.fromEntries(Object.entries(KEY_VARS).map(([id, name]) => [id, takeEnvSecret(name)]));
  const urls = Object.fromEntries(Object.entries(URL_VARS).map(([id, [name, given]]) => [id,
    takeEnvSecret(name) ?? given]));
  return { keys, urls };
}

/**
 * @brief 别的真实套件的 key（OTHER_KEY_VARS）与名字像 API key 的环境变量（KEY_LIKE）：读出并从 process.env 删掉，
 *        Mori 与它跑的命令都拿不到。值只用来换成 ***、查明文，不输进 Mori、不打印。
 * @return { names（删掉的变量名，可以打印）, values（够长的值） }
 */
function takeOtherKeys() {
  const names = [...new Set([...OTHER_KEY_VARS, ...Object.keys(process.env).filter((name) => KEY_LIKE.test(name))])]
    .filter((name) => process.env[name] !== undefined);
  const values = names.map((name) => takeEnvSecret(name)).filter((value) => value && value.length >= MIN_SECRET);
  return { names, values };
}

/** key 方式的 key 与地址：模块私有，不导出、不放进 ctx */
const keyEnv = takeKeyEnv();
/** 别的 key：模块私有 */
const otherKeys = takeOtherKeys();
/** 这次运行知道的 key（只用来换成 ***、查明文；没设环境变量时为空） */
const secrets = [...new Set([...Object.values(keyEnv.keys).filter(Boolean), ...otherKeys.values])];
/** 只换不记的版本（写结果文件、app.log 这类已经换过或另有核对的文字用它） */
const scrub = redactor(secrets);
/** 换掉过 key 的去处（不含 key）：leakCheck 报出，key 到了这次运行的输出里（换成 *** 之前） */
const redactHits = [];

/**
 * @brief 把文字里的 key 换成 ***（检查、日志与写出的文件都经它）。换掉过 key 时记下 where（leakCheck 报出；
 *        where 为 null 时不记）。
 * @param where 文字的去处（不含 key），例如 "check detail: <检查名>"
 */
export function redact(text, where = 'test output') {
  const source = String(text);
  const out = scrub(source);
  if (where && out !== source) redactHits.push(oneLine(scrub(where), 200));
  return out;
}

/** @brief 数据里有没有 key 的明文：字符串原样查，别的先 JSON.stringify。 */
export function leaked(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data) ?? '';
  return secrets.some((secret) => text.includes(secret));
}

/** @brief 一行概括：先把 key 换成 *** 再截短（先截短的话，跨过截断处的 key 会留下前一段）。 */
export const briefSafe = (value, max = 1500) => oneLine(redact(typeof value === 'string' ? value
  : JSON.stringify(value) ?? '', 'brief text'), max);

/** @brief 出错的一行文字（同样先换掉 key 再截短）。 */
export const errorText = (error, max = 600) => oneLine(redact(String(error?.stack ?? error), 'error text'), max);

/** @brief 打印一行（先换掉 key）。 */
export const log = (text) => console.log(`[fs-real] ${redact(text, 'log line')}`);

/** 这次运行的上下文（进程意外结束与 Ctrl+C 时用它清理） */
let live = null;
/** 已装过进程级的报错处理 */
let guarded = false;

/**
 * @brief 进程要立即结束时的清理（同步）：结束 Mori 的主进程，删掉这次用过的数据目录里的 credentials.json，打印留下的
 *        目录。出错时只打印。
 */
function emergencyCleanup(reason) {
  if (!live) return;
  try {
    live.app?.process()?.kill();
  } catch (error) {
    console.error(`[fs-real] could not kill Mori: ${errorText(error, 300)}`);
  }
  dropCredentials(live);
  console.error(`[fs-real] ${reason}; data dirs left (credentials.json removed): `
    + `${scrub(live.dataDirs.join(', ') || 'none')}`);
}

/**
 * @brief 没接住的报错也先把 key 换成 *** 再打印（例如 Playwright 填输入框出错时，报错里带着填的值）：
 *        unhandledRejection 打印后设退出码 1；uncaughtException 与 Ctrl+C 先清理（emergencyCleanup）再结束进程。
 */
function guardProcess() {
  if (guarded) return;
  guarded = true;
  process.on('unhandledRejection', (error) => {
    console.error(`[fs-real] unhandled rejection: ${errorText(error, 4000)}`);
    process.exitCode = 1;
  });
  process.on('uncaughtException', (error) => {
    console.error(`[fs-real] uncaught exception: ${errorText(error, 4000)}`);
    emergencyCleanup('uncaught exception');
    process.exit(1);
  });
  process.once('SIGINT', () => {
    emergencyCleanup('interrupted');
    process.exit(130);
  });
}

// ---------- 命令行 ----------

/** @brief --name 的值；缺失或紧跟着另一个 --参数时为 null。 */
function argValue(name) {
  const value = arg(name);
  return value && !value.startsWith('--') ? value : null;
}

/**
 * @brief 解析命令行。
 * @return { source, repo, exePath（已 resolve；没给时 null）, only（名字的数组；没给时 null）, keyMode（没给 --source）,
 *          suffix（--exe 时 -packaged）, resultFile（fs-real(-packaged).json；--only 时 fs-partial-real(-packaged).json，
 *          不计入覆盖检查）, shots（截图与 app.log 的目录 test-results/fs-real(-packaged)） }
 */
export function realArgs() {
  const path = (name) => (argValue(name) ? resolve(argValue(name)) : null);
  const exePath = path('exe');
  const only = argValue('only')?.split(',').map((item) => item.trim()).filter(Boolean) ?? null;
  const suffix = exePath ? '-packaged' : '';
  return { source: path('source'), repo: path('repo'), exePath, only, keyMode: !path('source'), suffix,
    resultFile: only ? `fs-partial-real${suffix}.json` : `fs-real${suffix}.json`,
    shots: join(appRoot, `test-results/fs-real${suffix}`) };
}

/**
 * @brief key 方式跑之前的检查：两个 key 都有值；没开 Playwright 的调试日志（它会打印填进去的 key）；地址是 http(s)
 *        URL。不合格时返回一句说明。
 */
function keyModeProblem() {
  const missing = Object.entries(KEY_VARS).filter(([id]) => !keyEnv.keys[id]).map(([, name]) => name);
  if (missing.length) {
    return `Missing --source <Mori data dir>, or for the key mode the env vars ${missing.join(', ')}.`;
  }
  if (PW_DEBUG.test(process.env.DEBUG ?? '') || process.env.PWDEBUG) {
    return 'Unset DEBUG (pw:*) and PWDEBUG for the key mode: Playwright would print the typed API keys.';
  }
  const bad = Object.entries(URL_VARS).filter(([id]) => !/^https?:\/\/[^/\s]+/i.test(keyEnv.urls[id]))
    .map(([, [name]]) => name);
  return bad.length ? `${bad.join(', ')} must be an http or https URL.` : null;
}

/**
 * @brief 跑之前的检查（不合格时不启动 Mori、不写结果文件）：带值的参数有值；--only 不为空、每个名字是某个步骤的名字或
 *        编号；--exe 存在；--repo 是一个 git 仓库；--source 方式下数据目录合格（checkSource：两个真实提供商、区域已确认、
 *        key 的 ref 在 credentials.json 里，只看键名），key 方式下两个 key、调试日志与地址（keyModeProblem）。
 * @param steps [{ name, ids }]：fs-real.mjs 的全部步骤
 * @return { problem（一句说明；合格时 null）, found（--source 方式下的 { first, second }；别的情况没有） }
 */
function startProblem(args, steps) {
  const bare = VALUE_FLAGS.filter((name) => process.argv.includes(`--${name}`) && !argValue(name));
  if (bare.length) return { problem: `${bare.map((name) => `--${name}`).join(', ')} needs a value.` };
  const known = [...new Set(steps.flatMap((step) => [step.name, ...step.ids]))];
  if (args.only?.length === 0) return { problem: `Empty --only; expected some of ${known.join(', ')}.` };
  const unknown = (args.only ?? []).filter((name) => !known.includes(name));
  if (unknown.length) return { problem: `Unknown --only ${unknown.join(', ')}; expected ${known.join(', ')}.` };
  if (args.exePath && !existsSync(args.exePath)) return { problem: `--exe ${args.exePath} does not exist.` };
  if (args.repo && (!existsSync(args.repo) || gitRun(args.repo, ['rev-parse', '--git-dir']).code !== 0)) {
    return { problem: `--repo ${args.repo} is not a git repository.` };
  }
  if (args.keyMode) return { problem: keyModeProblem() };
  const checked = checkSource(args.source);
  if (checked.error) return { problem: checked.error };
  if (!existsSync(join(args.source, 'model-profiles.json'))) {
    return { problem: `model-profiles.json is missing in ${args.source}; let Mori probe the two models first.` };
  }
  return { problem: null, found: checked.found };
}

/** @brief 这个步骤在这次运行里跑不跑：没有 --only，或 --only 里有它的名字或它的某个编号。 */
export const selected = (ctx, step) => !ctx.args.only || ctx.args.only.includes(step.name)
  || step.ids.some((id) => ctx.args.only.includes(id));

/** @brief 打印不跑的原因与用法（startProblem 不合格时）。 */
export function printUsage(ctx) {
  const names = ctx.steps.map((step) => step.name).join(',') || '<step names or FS ids>';
  console.error(`[fs-real] not run: ${redact(ctx.problem, 'usage line')}`);
  console.error('[fs-real] usage: node tests/ui/fs-real.mjs --source <Mori data dir> [--repo <second git repo>] '
    + `[--exe <Mori.exe>] [--only ${names}]`);
  console.error(`[fs-real]   or (key mode) with ${Object.values(KEY_VARS).join(' and ')} set (${URL_VARS.deepseek[0]}, `
    + `${URL_VARS.glm[0]} optional; DEBUG without pw:* and no PWDEBUG): node tests/ui/fs-real.mjs `
    + '[--repo <second git repo>] [--exe <Mori.exe>] [--only <step names or FS ids>]');
  console.error(`[fs-real] no result file was written (test-results/${ctx.args.resultFile} is left as it was)`);
}

// ---------- 结果文件 ----------

/** @brief 写进结果文件的文字：别的值写成 JSON，先换掉 key（换掉过时记下 where），再截到 DETAIL_MAX。 */
function resultText(value, where) {
  const text = redact(typeof value === 'string' ? value : JSON.stringify(value) ?? '', where);
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

/**
 * @brief 结果收集器。record(name, ok, detail, note) 记一条检查：名字、detail、note 都先把 key 换成 ***（detail 与 note
 *        可以是字符串或别的值，别的值写成 JSON），ok 按真假记；模型说了什么、做了什么写进 note（§19.1：只断言程序保证的
 *        事）。note(text) 记一条整次运行的说明。write() 写 test-results/<resultFile>：{ target, mode, checks: [{ name,
 *        ok, detail, known: false, note? }], notes }（spec-coverage.mjs 读 checks），全部通过时返回 true。
 */
function createResults(args) {
  const data = { target: args.exePath ?? 'dev build', mode: args.keyMode ? 'key' : 'source', checks: [], notes: [] };
  return {
    data,
    record(name, ok, detail = '', note = '') {
      const title = oneLine(scrub(name), 160);
      const item = { name: redact(name, `check name: ${title}`), ok: Boolean(ok),
        detail: resultText(detail, `check detail: ${title}`), known: false };
      if (note) item.note = resultText(note, `check note: ${title}`);
      data.checks.push(item);
      console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${oneLine(item.detail, 400)}` : ''}`);
      if (item.note) console.log(`  note: ${oneLine(item.note, 400)}`);
    },
    note(value) {
      data.notes.push(resultText(value, 'run note'));
    },
    write() {
      mkdirSync(join(appRoot, 'test-results'), { recursive: true });
      writeFileSync(join(appRoot, 'test-results', args.resultFile), `${scrub(JSON.stringify(data, null, 2))}\n`);
      return data.checks.every((check) => check.ok);
    },
  };
}

// ---------- 窗口里的 key 与截图 ----------

/**
 * @brief 窗口此刻显示的文字：body 的 innerText，加上每个不是密码框的输入框、文本框的值（密码框只显示圆点）。
 * @return 文字；读不出（页面已关、正在跳转）或 READ_MS 内没读到（渲染进程卡住）时为 null
 */
const windowText = (page) => within(page.evaluate(() => [document.body.innerText,
  ...[...document.querySelectorAll('input:not([type="password"]), textarea')].map((el) => el.value)].join('\n'))
  .catch(() => null), READ_MS, null);

/**
 * @brief 查窗口里有没有 key 的明文（只在知道 key 时查）：出现时把 label 记进 ctx.shownKeys（leakCheck 报出），读不出时
 *        记进 ctx.unreadWindows（不当成没有）。
 * @return 可以截图为 true（没有 key，或这次运行不知道 key）
 */
async function windowClean(ctx, label) {
  if (secrets.length === 0) return true;
  const text = await windowText(ctx.page);
  if (text === null) {
    ctx.unreadWindows.push(label);
    return false;
  }
  const shown = secrets.some((secret) => text.includes(secret));
  if (shown) ctx.shownKeys.push(label);
  return !shown;
}

/**
 * @brief 截图到 ctx.args.shots/<name>.png（失败也不报错）。截之前查窗口的文字（windowClean）：出现 key 或读不出时不截，
 *        只打印一行。场景模块用它截图，不用 fs-helpers.mjs 的 shotFs（那个不查 key）。
 * @return 截了为 true
 */
export async function shotReal(ctx, name) {
  if (!ctx.page || ctx.page.isClosed()) return false;
  if (!(await windowClean(ctx, `before the screenshot ${name}`))) {
    log(`screenshot ${name} not taken: the window text shows a key or could not be read`);
    return false;
  }
  mkdirSync(ctx.args.shots, { recursive: true });
  return ctx.page.screenshot({ path: join(ctx.args.shots, `${name}.png`) }).then(() => true, () => false);
}

// ---------- 记录代理（synthetic test setup，只记请求体） ----------

/** @brief 请求体按 JSON 解析；空的或不是 JSON 时为 null。 */
function parseBody(raw) {
  try {
    return raw.length ? JSON.parse(String(raw)) : null;
  } catch {
    // 不是 JSON 的请求体不记内容
    return null;
  }
}

/** @brief 记一条代理出错（先换掉 key）并打印。 */
function proxyError(proxy, text) {
  const line = redact(text, 'recording proxy error');
  proxy.errors.push(line);
  console.error(`[fs-real-proxy] ${line}`);
}

/**
 * @brief 上游的响应原样流回 Mori。响应头之后上游中途断开时（IncomingMessage 没有 error 监听时不发 error，pipe 也不
 *        结束 res），记一条代理出错并断开 Mori 这边的连接，Mori 立即看到断开、按它自己的规则处理。
 * @param link { res, item（这个请求的记录）, label（提供商与路径）, isGone（Mori 是否已先断开） }
 */
function pipeAnswer(proxy, { res, item, label, isGone }, answer) {
  item.status = answer.statusCode;
  res.writeHead(answer.statusCode ?? 502, answer.headers);
  let reason = 'upstream closed mid-response';
  answer.on('error', (error) => {
    reason = `upstream closed mid-response (${error.message})`;
  });
  answer.on('close', () => {
    if (answer.complete || isGone()) return;
    item.status = 'aborted';
    proxyError(proxy, `${label}: ${reason}`);
    res.destroy();
  });
  answer.pipe(res);
}

/**
 * @brief 转发一个请求（请求头除 host 外原样带上，响应原样流回），记下 { t, provider, method, path（真实地址的路径）,
 *        chat（有 messages 的 POST：对话请求，fs-helpers.mjs sendFs 认它）, model, body, status }；不记请求头。
 *        Mori 先断开（停止、取消）之后上游的报错不算代理出错。
 */
function forwardReal(proxy, { req, res, provider, base, rest }, raw) {
  const target = new URL(`${base.replace(/\/+$/, '')}${rest}`);
  const body = parseBody(raw);
  const item = { t: Date.now(), provider, method: req.method, path: target.pathname,
    chat: req.method === 'POST' && Array.isArray(body?.messages), model: body?.model ?? null, body, status: null };
  proxy.captures.push(item);
  let gone = false;
  const label = `${provider} ${target.pathname}`;
  const client = target.protocol === 'https:' ? https : http;
  const upstream = client.request(target, { method: req.method, headers: { ...req.headers, host: target.host } },
    (answer) => pipeAnswer(proxy, { res, item, label, isGone: () => gone }, answer));
  upstream.on('error', (error) => {
    if (gone) return;
    item.status = 'error';
    proxyError(proxy, `${label}: ${error.message}`);
    res.destroy();
  });
  res.on('close', () => {
    gone = true;
    upstream.destroy();
  });
  upstream.end(raw);
}

/**
 * @brief 启动记录代理：/p/<提供商 id><其余> 转发到 routes[id] + <其余>；别的路径回 404，不转发。
 * @param routes 提供商 id → 真实地址（prepareRealData 的 routes）
 * @return { port, captures, errors（每条一句，已换掉 key）, server }；端口被占用时 reject
 */
export function startRealProxy(port, routes) {
  const proxy = { port, captures: [], errors: [], server: null };
  proxy.server = http.createServer((req, res) => {
    const match = /^\/p\/([^/?]+)(.*)$/.exec(req.url ?? '');
    const base = match ? routes[match[1]] : undefined;
    if (!base) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => forwardReal(proxy, { req, res, provider: match[1], base, rest: match[2] },
      Buffer.concat(chunks)));
  });
  return new Promise((done, fail) => {
    proxy.server.once('error', fail);
    proxy.server.listen(port, '127.0.0.1', () => done(proxy));
  });
}

/** @brief 关掉记录代理（断开全部连接，端口不再监听）。 */
export function stopRealProxy(proxy) {
  if (!proxy?.server?.listening) return Promise.resolve();
  proxy.server.closeAllConnections?.();
  return new Promise((done) => proxy.server.close(() => done()));
}

/** @brief 路径比较用的写法（/ 与 \ 不分、大小写不分）。 */
const pathKey = (path) => String(path ?? '').replace(/\\/g, '/').toLowerCase();

/** @brief 对话请求体的 system 文字：Anthropic 接口的 system 字段与 OpenAI 接口的 system / developer 消息。 */
function systemText(body) {
  const parts = [body.system === undefined ? '' : contentText(body.system), ...body.messages
    .filter((m) => m.role === 'system' || m.role === 'developer').map((m) => contentText(m.content))];
  return parts.filter(Boolean).join('\n');
}

/**
 * @brief 记录代理收到的对话请求（有 messages 的 POST），按收到的顺序，每项 { t, provider, model, status, system,
 *        identity（fs-helpers.mjs identityOf：身份段的行与权限句的模式）, tools（工具名）, users（每条 user 消息的文字）,
 *        lastUser, messages（原样的消息） }。
 * @param where { since（毫秒时刻）, cwd（给出时只留 system 里有它的：每个场景一个临时项目，探针的请求没有）,
 *        marker（给出时只留某条 user 消息含它的） }
 */
export function realRequests(ctx, { since = 0, cwd = null, marker = null } = {}) {
  return (ctx.proxy?.captures ?? []).filter((item) => item.chat && item.t >= since).map((item) => {
    const system = systemText(item.body);
    const users = item.body.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content));
    return { t: item.t, provider: item.provider, model: item.model, status: item.status, system,
      identity: identityOf(system), tools: (item.body.tools ?? []).map((tool) => tool.function?.name ?? tool.name),
      users, lastUser: users.at(-1) ?? '', messages: item.body.messages };
  }).filter((r) => (!cwd || pathKey(r.system).includes(pathKey(cwd)))
    && (marker === null || r.users.some((text) => text.includes(marker))));
}

// ---------- 数据目录：key 方式只经界面建（步骤与问题清单在 v1-real-helpers.mjs） ----------

/** key 方式建目录出错时那一条检查 */
const KEY_SETUP = `${SETUP_ID} real setup (key mode): the data dir is built through the UI (first run with DeepSeek, `
  + 'Add provider for GLM, each API key typed into its password field)';

/**
 * @brief 建目录时启动 Mori（key 方式）：数据目录为 dir（快照目录在它旁边），不设 When you’re away，等 ready 的标识出现，
 *        装 md-real-helpers.mjs 的录制器（waitProbed 读它）。输出照样收进 ctx.appLog（leakCheck 查它）。
 */
async function startBuild(ctx, dir, ready) {
  Object.assign(ctx, { userData: dir, snapshots: snapshotsDirFor(dir), env: {} });
  await startFsApp(ctx, { away: null });
  await ctx.page.getByTestId(ready).waitFor({ timeout: 60000 });
  await ctx.page.evaluate(installRecorder);
}

/**
 * @brief key 方式第一步：全新的数据目录启动到首次启动表单，经表单接上 DeepSeek（共用的 firstRunDeepSeek，截图用
 *        shotReal），按共用的 firstRunProblems 记一条检查，关掉 Mori。
 * @return 检查通过为 true
 */
async function keyFirstRun(ctx, dir) {
  await startBuild(ctx, dir, 'connection-form');
  const url = keyEnv.urls.deepseek;
  const run = await firstRunDeepSeek(ctx.page, { baseUrl: url, key: keyEnv.keys.deepseek,
    shot: (name) => shotReal(ctx, name) });
  const problems = firstRunProblems(run, url);
  ctx.record(`${SETUP_ID} real setup (key mode): first run with DeepSeek (${url}, API key typed into its password `
    + `field): Fetch models shows "Detected: DeepSeek"; with only ${run.doc?.id ?? 'a documented model'} ticked and `
    + 'Test connection saves the provider (the Base URL host, one saved key, only that model), '
    + 'connects, and its probes finish with tool calling verified', problems.length === 0,
  { problems, ids: run.rows.map((row) => row.id), picked: run.picked, text: run.text,
    provider: providerBrief(run.provider) });
  await stopReal(ctx);
  return problems.length === 0;
}

/**
 * @brief 等 GLM 的探针跑完（复制这个目录之后不因档案没写完而重新探测），读出它的档案的状态与工具调用（随模型，
 *        写进 detail，不算问题）。
 * @return { ref, probed（PROBE_MS 内跑完）, status, toolCalling }；没加上模型时 { probed: false }
 */
async function glmProbe(ctx, glm) {
  if (!glm.provider || !glm.picked) return { probed: false };
  const ref = `${glm.provider.id}/${glm.picked}`;
  const probed = await waitProbed(ctx.page, ref, glm.since, PROBE_MS);
  const info = await ctx.page.evaluate(() => window.mori.request({ type: 'models.get' })).catch(() => null);
  const profile = info?.profiles?.[ref];
  return { ref, probed, status: profile?.status ?? null, toolCalling: profile?.tool_calling?.state ?? null };
}

/**
 * @brief key 方式第二步：重新打开 Mori，设置 → Models → Add provider 接 GLM（共用的 addProviderUi + chooseGlm，问题清单
 *        glmAddProblems），等它的探针跑完（glmProbe；没跑完算一个问题），记一条检查，关掉 Mori。
 * @return 检查通过为 true
 */
async function keyGlm(ctx, dir) {
  await startBuild(ctx, dir, 'sidebar');
  await openModelsSettings(ctx.page);
  const url = keyEnv.urls.glm;
  const glm = await addProviderUi(ctx.page, { baseUrl: url, key: keyEnv.keys.glm, choose: chooseGlm });
  const problems = glmAddProblems(glm, url);
  await shotReal(ctx, 'setup-glm');
  const probe = await glmProbe(ctx, glm);
  if (glm.provider && glm.picked && !probe.probed) {
    problems.push(`${glm.picked} probes did not finish within ${PROBE_MS / 60000} min`);
  }
  ctx.record(`${SETUP_ID} real setup (key mode): Add provider for GLM (${url} and its API key in the password `
    + 'field): Fetch models shows the model list with "Detected: Anthropic-compatible server" (or a list error '
    + 'without a Detected line); GLM-5.3 is entered with Add a model ID (or ticked when the server lists it) and Add '
    + 'saves the provider (the Base URL host, its API type, Public, one saved key) with only it; its probes finish '
    + `within ${PROBE_MS / 60000} min (profile status and tool calling in the detail)`,
  problems.length === 0, { problems, detected: glm.state.detected, listError: glm.state.listError,
    provider: providerBrief(glm.provider), probe });
  await stopReal(ctx);
  return problems.length === 0;
}

/**
 * @brief key 方式：建一个全新的数据目录，只经界面接上 DeepSeek 与 GLM（keyFirstRun、keyGlm）；出错时记一条失败。
 * @return 数据目录；没建成时为 null
 */
async function buildKeyDir(ctx) {
  const dir = mkdtempSync(join(tmpdir(), 'mori-fs-real-keys-'));
  ctx.dataDirs.push(dir);
  log(`key mode: building a new data dir in ${dir} through the UI`);
  try {
    const ok = await keyFirstRun(ctx, dir) && await keyGlm(ctx, dir);
    return ok ? dir : null;
  } catch (error) {
    ctx.record(KEY_SETUP, false, errorText(error));
    await shotReal(ctx, 'setup-error');
    await stopReal(ctx);
    return null;
  }
}

/**
 * @brief key 方式的数据来源：建目录（buildKeyDir），记建目录时的页面错误，再像 --source 一样检查它（checkSource）。
 *        之后的步骤的页面错误从空开始记。
 * @return 可以接着准备为 true
 */
async function keySource(ctx) {
  const dir = await buildKeyDir(ctx);
  const errors = ctx.pageErrors.splice(0);
  ctx.record(`${SETUP_ID} real setup (key mode): the page reported no errors while the data dir was built through the `
    + 'UI', errors.length === 0, errors.slice(0, 3).join(' | '));
  if (!dir) return false;
  const checked = checkSource(dir);
  const error = checked.error ?? (existsSync(join(dir, 'model-profiles.json')) ? null
    : 'model-profiles.json was not written (the probes did not finish)');
  if (error) {
    ctx.record(`${SETUP_ID} real setup (key mode): the data dir built through the UI has DeepSeek and GLM with saved `
      + 'keys and their profiles', false, error);
    return false;
  }
  Object.assign(ctx, { sourceDir: dir, found: checked.found });
  return true;
}

/** @brief 读 JSON 文件；读不出时把原因加进 problems，返回 null。 */
function readJsonInto(file, problems) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push(`${basename(file)} could not be read: ${error.code ?? error.message}`);
    return null;
  }
}

/** @brief 记录代理上这个提供商的地址。 */
const proxiedUrl = (id) => `http://127.0.0.1:${PROXY_PORT}/p/${id}`;

/** @brief 复制出的 model-config.json 合不合测试准备：默认范围是 REAL_GROUP、成员为 ids，每个提供商的地址指向代理。 */
function configProblems(config, ids) {
  const problems = [];
  if (config.normalDefault !== REAL_GROUP) problems.push(`normalDefault is ${config.normalDefault}`);
  const members = config.groups?.find((group) => group.id === REAL_GROUP)?.members;
  if (JSON.stringify(members) !== JSON.stringify(ids)) {
    problems.push(`group ${REAL_GROUP} has the members ${JSON.stringify(members)}`);
  }
  for (const id of ids) {
    const baseUrl = config.providers?.find((item) => item.id === id)?.baseUrl;
    if (baseUrl !== proxiedUrl(id)) problems.push(`provider ${id} has the baseUrl ${baseUrl}`);
  }
  return problems;
}

/**
 * @brief 复制出的数据目录合不合测试准备（读回来核对，不读 key）：加密的 credentials.json 与 Local State 在、
 *        pi/models.json 不在；model-config.json 合格（configProblems）；两个模型的档案没有留在真实地址上。某个模型
 *        还没有档案时只写进整次运行的说明（Mori 第一次启动时经代理探测它，waitModels 等）。
 * @return 不合的地方；合格时为空数组
 */
function copiedProblems(ctx, dir) {
  const problems = ['credentials.json', 'Local State'].filter((name) => !existsSync(join(dir, name)))
    .map((name) => `${name} was not copied`);
  if (existsSync(join(dir, 'pi', 'models.json'))) problems.push('pi/models.json is in the copied data dir');
  const providers = [ctx.found.first, ctx.found.second];
  const config = readJsonInto(join(dir, 'model-config.json'), problems);
  if (config) problems.push(...configProblems(config, providers.map((provider) => provider.id)));
  const profiles = readJsonInto(join(dir, 'model-profiles.json'), problems)?.profiles ?? [];
  for (const provider of providers) {
    const model = provider.models[0].id;
    const at = (url) => profiles.some((item) => item.baseUrl === url && item.modelId === model);
    if (at(ctx.routes[provider.id])) {
      problems.push(`the profile of ${provider.id}/${model} is still at the real URL`);
    } else if (!at(proxiedUrl(provider.id))) {
      ctx.note(`no stored profile of ${provider.id}/${model}: Mori probes it at the first start through the proxy`);
    }
  }
  return problems;
}

/**
 * @brief 准备（两种方式）：key 方式先经界面建数据目录；复制数据目录并做测试准备（prepareRealData：分组为默认范围、
 *        地址改指记录代理），读回来核对（copiedProblems），启动记录代理，记一条 setup 检查。出错时记一条失败。不启动
 *        Mori（ensureReal 在第一个步骤之前启动）。
 * @return 可以跑步骤为 true
 */
export async function prepareReal(ctx) {
  mkdirSync(ctx.args.shots, { recursive: true });
  const name = `${SETUP_ID} real setup: two real providers with saved keys; the copied data dir `
    + `(encrypted key files, no pi/models.json) has the default range ${REAL_GROUP} [first, second] and points both `
    + `providers and their profiles at the recording proxy http://127.0.0.1:${PROXY_PORT}/p/<provider id> `
    + '(synthetic test setup)';
  try {
    if (ctx.keyMode && !(await keySource(ctx))) return false;
    const { first, second } = ctx.found;
    const data = prepareRealData(ctx.sourceDir, ctx.found, PROXY_PORT);
    ctx.dataDirs.push(data.userData);
    Object.assign(ctx, { userData: data.userData, snapshots: snapshotsDirFor(data.userData), routes: data.routes,
      refs: { first: refOf(first), second: refOf(second) } });
    const problems = copiedProblems(ctx, data.userData);
    ctx.proxy = await startRealProxy(PROXY_PORT, data.routes);
    ctx.ep = { proxy: ctx.proxy };
    ctx.record(name, problems.length === 0, { problems, first: `${first.name} ${refOf(first)} (${first.baseUrl})`,
      second: `${second.name} ${refOf(second)} (${second.baseUrl})`,
    data: data.userData, built: ctx.keyMode ? ctx.sourceDir : null });
    return problems.length === 0;
  } catch (error) {
    ctx.record(name, false, errorText(error));
    return false;
  }
}

/** @brief 删掉这次用过的数据目录里 key 的密文副本（credentials.json）；不碰 --source 给的目录。 */
function dropCredentials(ctx) {
  for (const dir of ctx.dataDirs) {
    try {
      rmSync(join(dir, 'credentials.json'), { force: true });
    } catch (error) {
      console.error(`[fs-real] could not remove ${join(dir, 'credentials.json')}, delete it by hand: `
        + errorText(error, 300));
    }
  }
}

// ---------- App ----------

/** @brief 启动选项的标识（ensureReal 比较用）。 */
const startKey = ({ awayMs = null, away = null, env = {} } = {}) => JSON.stringify([awayMs, away, env]);

/**
 * @brief 第一次启动之后等两个真实模型的档案不是 probing（复制出的档案指纹不变时立即就是），记一条检查：PROBE_MS 内
 *        都不再是 probing（程序保证探针有时限）；状态与工具调用随模型，写进 note 与整次运行的说明。
 */
async function waitModels(ctx) {
  const refs = [ctx.refs.first, ctx.refs.second];
  let info = null;
  let failure = '';
  try {
    info = await waitProfiles(ctx.page, refs, PROBE_MS);
  } catch (error) {
    failure = errorText(error, 300);
  }
  const states = refs.map((ref) => `${ref} ${info?.profiles[ref]?.status ?? 'unknown'}, tool calling `
    + `${info?.profiles[ref]?.tool_calling?.state ?? 'unknown'}`).join('; ');
  ctx.record(`${SETUP_ID} real setup: at the first start the profiles of both models are not probing within `
    + `${PROBE_MS / 60000} min`, info !== null, failure, states);
  ctx.note(`profiles at the first start: ${states}`);
}

/**
 * @brief 用复制出的数据目录启动 Mori（已开着时先关掉）：MORI_USER_DATA 为 ctx.userData，MORI_SNAPSHOTS_DIR 为它旁边的
 *        快照目录（fs-helpers.mjs startFsApp：订阅事件、阶段行、出现过的批准卡，输出收进 ctx.appLog）；等侧栏出现；
 *        设 When you’re away：awayMs 为空时 Never（§19.4），给了 awayMs 时环境变量 MORI_AWAY_TIMEOUT_MS=awayMs（§9.3：
 *        三档时长都换成它）并设 away（默认 '60s'，原文里的时长按它写）；装页面里的录制器；第一次启动时等两个模型的档案
 *        （waitModels）。
 * @param opts { awayMs（毫秒；null 时不设）, away（'60s' | '5m' | '10m' | 'never'；null 时按 awayMs 取默认）,
 *        env（另加的环境变量，例如 MORI_GIT_PATH） }
 * @return ctx.page
 */
export async function startReal(ctx, { awayMs = null, away = null, env = {} } = {}) {
  if (ctx.app) await stopReal(ctx);
  const timeout = away ?? (awayMs ? '60s' : 'never');
  ctx.env = { ...env, ...(awayMs ? { MORI_AWAY_TIMEOUT_MS: String(awayMs) } : {}) };
  ctx.projectTabs = {};
  await startFsApp(ctx, { away: timeout === 'never' ? 'never' : null });
  await ctx.page.getByTestId('sidebar').waitFor({ timeout: 60000 });
  if (timeout !== 'never') await setAwayTimeout(ctx, timeout);
  Object.assign(ctx, { awayMs, awayTimeout: timeout, startedWith: startKey({ awayMs, away, env }) });
  ctx.started += 1;
  await ctx.page.evaluate(installFsRecorder);
  if (ctx.started === 1) await waitModels(ctx);
  return ctx.page;
}

/**
 * @brief Mori 按 opts（同 startReal）开着时什么都不做，否则（没开、页面已关、选项不同）用 opts 重新启动。
 *        runReal 在每个步骤之前用步骤的 start 调用它。
 * @return ctx.page
 */
export async function ensureReal(ctx, opts = {}) {
  if (ctx.app && ctx.page && !ctx.page.isClosed() && ctx.startedWith === startKey(opts)) return ctx.page;
  return startReal(ctx, opts);
}

/** @brief 关掉 Mori 再用 opts 启动（同一个数据目录；之后要重新打开会话）。 */
export const restartReal = (ctx, opts = {}) => startReal(ctx, opts);

/** @brief 界面重新载入（fs-helpers.mjs reloadFsUi，后台进程不停），再装页面里的录制器（之前录下的步骤随页面丢掉）。 */
export async function reloadReal(ctx) {
  await reloadFsUi(ctx);
  await ctx.page.evaluate(installFsRecorder);
}

/**
 * @brief 关掉 Mori：先查一次窗口里有没有 key（windowClean），有序关闭后台进程，最多等 CLOSE_MS；没关掉时结束主进程，
 *        不留进程。没开着时什么都不做。
 */
export async function stopReal(ctx) {
  const { app } = ctx;
  if (!app) return;
  if (ctx.page && !ctx.page.isClosed()) await windowClean(ctx, 'before Mori closed');
  Object.assign(ctx, { app: null, page: null, startedWith: null });
  const closed = await within(app.close().then(() => true, () => true), CLOSE_MS, false);
  if (!closed) {
    console.error(`[fs-real] Mori did not close within ${CLOSE_MS / 1000} s; killing its main process`);
    app.process().kill();
  }
}

// ---------- 临时项目（synthetic test setup） ----------

/**
 * @brief 测试准备（synthetic）：新的临时目录 root 下的项目 root\project（fs-git-helpers.mjs makeProject：README.md 加
 *        files；repo 为真时 git init 并提交一次，提交者只在这个临时仓库里设），branch 给出时把当前分支改名为它；
 *        写到工作路径外的目标放在 root 里（项目的上一级）。leakCheck 查整个 root。
 * @param name 临时目录名里的一段（mori-fs-real-<name>-）
 * @param opts { repo, files（相对路径 → 内容）, branch }
 * @return { root, project }
 */
export async function newRealProject(ctx, name, { repo = false, files = {}, branch = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), `mori-fs-real-${name}-`));
  const project = makeProject(root, 'project', { files, repo });
  if (repo && branch) git(project, 'branch', '-M', branch);
  ctx.projects.push({ root, project });
  return { root, project };
}

// ---------- 页面里的录制器（格式同 m2-record.mjs、md-record.mjs） ----------

/**
 * @brief 在页面里装录制器 window.__fsReal（page.evaluate 执行；startReal、reloadReal 已装）：begin 与 end 之间记下录制器
 *        自己经 window.mori.request 发的命令与结果（{ t, command }、{ t, result: { type, value | error } }，不排队：
 *        session.prompt 与 approval.answer 可以交错）和后台进程转发的全部事件（{ t, envelope }），t 从 begin 起算。
 *        window.mori 是冻结的（contextBridge），录不到界面自己发的命令。
 */
export function installFsRecorder() {
  if (window.__fsReal) return;
  const rec = {
    steps: [], t0: performance.now(), recording: false,
    log(entry) {
      if (this.recording) this.steps.push({ t: Math.round(performance.now() - this.t0), ...entry });
    },
    begin() {
      this.steps = [];
      this.t0 = performance.now();
      this.recording = true;
    },
    end() {
      this.recording = false;
      return this.steps;
    },
    async cmd(command) {
      this.log({ command });
      try {
        const value = await window.mori.request(command);
        this.log({ result: { type: command.type, value } });
        return value;
      } catch (error) {
        this.log({ result: { type: command.type, error: error.message } });
        throw error;
      }
    },
  };
  window.mori.onEvent((envelope) => rec.log({ envelope }));
  window.__fsReal = rec;
}

/**
 * @brief 开始录一份 fixture（清掉之前的步骤），记下此刻已有几条检查（saveFixture 核对这之后记的检查都通过）。
 */
export async function recBegin(ctx) {
  ctx.recFrom = ctx.out.data.checks.length;
  await ctx.page.evaluate(() => window.__fsReal.begin());
}

/** @brief 录制器发一条命令（经 window.mori.request，命令与结果都进录制），返回结果；后台进程报错时抛错。 */
export const recCmd = (ctx, command) => ctx.page.evaluate((item) => window.__fsReal.cmd(item), command);

/**
 * @brief 记下界面自己发的一条命令：{ t, note, command }，没有 result（录制器录不到界面的命令；command 由调用方按界面的
 *        操作写出）。回放桥把带 command 的步骤都当成界面发的命令，只用于回放桥直接应答的命令（只读查询、away.set 等，
 *        harness/replay.js answeredDirectly），否则回放的顺序对不上。
 */
export const recUi = (ctx, command, note) => ctx.page.evaluate((entry) => window.__fsReal.log(entry),
  { note, command });

/** @brief 到现在为止录下的步骤（不停止录制）。 */
export const recSteps = (ctx) => ctx.page.evaluate(() => window.__fsReal.steps);

/** @brief 停止录制，返回这份 fixture 的步骤；页面已关时为 null。 */
export const recEnd = (ctx) => (ctx.page && !ctx.page.isClosed()
  ? ctx.page.evaluate(() => window.__fsReal.end()).catch(() => null) : Promise.resolve(null));

/**
 * @brief 录下的事件：[{ t（从 recBegin 起的毫秒）, sessionId, event }]，可按事件类型与信封的会话 id 筛（null 时不筛）。
 */
export function recEvents(ctx, type = null, sessionId = null) {
  return ctx.page.evaluate(({ kind, sid }) => window.__fsReal.steps.filter((step) => step.envelope
    && (kind === null || step.envelope.event?.type === kind) && (sid === null || step.envelope.sessionId === sid))
    .map((step) => ({ t: step.t, sessionId: step.envelope.sessionId, event: step.envelope.event })),
  { kind: type, sid: sessionId });
}

/**
 * @brief 等录下的事件里出现类型为 type、test(event) 为真的一个，最多 timeout 毫秒。
 * @param opts { sessionId（信封的会话 id；null 时不筛）, timeout }
 * @return 那一项（recEvents 的形状）；超时为 null
 */
export async function recWaitEvent(ctx, type, test = () => true, { sessionId = null, timeout = 180000 } = {}) {
  return poll(async () => (await recEvents(ctx, type, sessionId)).find((item) => test(item.event)) ?? null,
    timeout, 250);
}

/** @brief 等这个会话录下第 count 次 agent_settled（一次运行结束），最多 timeout 毫秒；超时时抛错。 */
export async function recSettled(ctx, sessionId, count, timeout = 600000) {
  const done = await poll(async () => (await recEvents(ctx, 'agent_settled', sessionId)).length >= count,
    timeout, 500);
  if (!done) throw new Error(`session ${sessionId} did not settle ${count} time(s) within ${timeout / 1000} s`);
}

/**
 * @brief 录制器打开一个会话：session.create { cwd }（有 trust 时带上），再像界面打开会话时一样读一次 workspace.status
 *        （只读查询，回放桥合成它的结果）。
 * @return session.create 的结果（SessionInfo：sessionId、sessionFile、cwd…）
 */
export async function recOpenSession(ctx, cwd, { trust = null } = {}) {
  const created = await recCmd(ctx, { type: 'session.create', cwd, ...(trust ? { trust } : {}) });
  await recCmd(ctx, { type: 'workspace.status', sessionId: created.sessionId });
  return created;
}

/** @brief fixture 的 notes：数据目录从哪来、测试准备（synthetic），以及 key 没有进录制。 */
function setupNotes(ctx) {
  const origin = ctx.keyMode ? 'the data dir this run built through the UI (first run with DeepSeek, then Add '
    + 'provider for GLM; each key was typed into Mori\'s API key field and saved encrypted by Mori)'
    : 'the owner\'s Mori data dir';
  const away = ctx.awayMs ? `${ctx.awayTimeout} with MORI_AWAY_TIMEOUT_MS=${ctx.awayMs}` : ctx.awayTimeout;
  return [`Setup (synthetic test setup, docs/specs/file-system.md §19.1): a copy of ${origin}, encrypted key files `
    + `only; default range ${REAL_GROUP} [${ctx.found.first.id}, ${ctx.found.second.id}]; both providers point at the `
    + `local recording proxy http://127.0.0.1:${PROXY_PORT}/p/<provider id> (request bodies only, no headers); the `
    + `When you're away: ${away}`,
  'The commands carry no API key and the fixture stores no request headers'];
}

/**
 * @brief 录制本身的问题：名字不是 §19.1 的三份之一；页面在录完之前关了；步骤里有出错的命令结果；没调 recBegin；
 *        recBegin 之后记的检查有没通过的。
 */
function recordingProblems(ctx, name, steps) {
  const out = [];
  if (!FIXTURE_NAMES.includes(name)) {
    out.push(`${name} is not one of the replay fixtures ${FIXTURE_NAMES.join(', ')} (§19.1)`);
  }
  const errors = (steps ?? []).filter((step) => step.result?.error);
  out.push(...errors.map((step) => `${step.result.type}: ${step.result.error}`));
  if (steps === null) out.push('the page closed before the recording ended');
  const failed = ctx.recFrom === null ? [] : ctx.out.data.checks.slice(ctx.recFrom).filter((check) => !check.ok);
  out.push(...failed.map((check) => `check failed: ${check.name}`));
  if (ctx.recFrom === null) out.push('recBegin was not called before saveFixture');
  return out;
}

/** @brief fixture 的外层（同 m2-record.mjs、md-record.mjs）。 */
function fixtureOf(ctx, name, meta, steps) {
  const model = meta.model ?? ctx.refs.first;
  const endpoint = ctx.routes[model.split('/')[0]] ?? ctx.found.first.baseUrl;
  return { source: 'real', note: 'Recorded from the real App and real models by tests/ui/fs-real.mjs; do not edit by '
    + 'hand.', name, description: meta.description, covers: meta.covers, recorded: localDate(), address: endpoint,
  endpoint, model, notes: [...setupNotes(ctx), ...(meta.notes ?? [])], recordedAt: new Date().toISOString(),
  steps: steps ?? [] };
}

/**
 * @brief 停止录制，写成回放 fixture（fixtureOf），记录制的检查：FS-114 一条，meta.covers 里有真实一层的编号
 *        （REAL_IDS，例如 work-scratch 的 FS-54）各一条。在场景自己的核对之后调用。没有问题（problems 为空、
 *        recordingProblems 为空）、也不含 key 时写到 tests/fixtures/filesystem/<name>.json，否则写到
 *        test-results/fs-real/<name>.rejected.json；写之前把 key 换成 ***。
 * @param name FIXTURE_NAMES 之一（别的名字只写到 REJECTED_DIR）
 * @param meta { description, covers（编号的数组）, what（检查名里的说明）, model?（<provider>/<model>，默认首选提供商的
 *        第一个模型；endpoint 取它的真实地址）, notes?（追加的说明：模型怎么做的、哪几步是 synthetic） }
 * @param problems 场景核对不通过的地方（必须给，没有时为 []）
 * @return { file, ok, steps }
 */
export async function saveFixture(ctx, name, meta, problems) {
  if (!Array.isArray(problems)) throw new Error(`saveFixture(${name}) needs the scenario's problems as an array`);
  const steps = await recEnd(ctx);
  const failed = [...problems, ...recordingProblems(ctx, name, steps)];
  ctx.recFrom = null;
  const fixture = fixtureOf(ctx, name, meta, steps);
  if (leaked(fixture)) failed.push(LEAKED);
  const file = failed.length ? join(REJECTED_DIR, `${name}.rejected.json`) : join(FIXTURE_DIR, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${redact(JSON.stringify(fixture, null, 1), `fixture ${name}`)}\n`);
  ctx.written.push(file);
  const events = fixture.steps.filter((step) => step.envelope).length;
  const ids = [...new Set([SETUP_ID, ...meta.covers.filter((id) => REAL_IDS.includes(id))])];
  for (const id of ids) {
    ctx.record(`${id} real record: ${meta.what} is recorded as the replay fixture tests/fixtures/filesystem/`
      + `${name}.json (covers ${meta.covers.join(', ')}; the format of m2-record.mjs and md-record.mjs)`,
    failed.length === 0, `${file} — ${fixture.steps.length} steps, ${events} events — ${briefSafe(failed)}`);
  }
  return { file, ok: failed.length === 0, steps: fixture.steps };
}

// ---------- 重跑 ----------

/**
 * @brief 前提没满足时重跑（最多 ATTEMPTS 次，同 mem-real.mjs withRetries、tb-real.mjs runDrive）：once(attempt, 上一次的
 *        结果) 返回 { unmet（没满足的原因；满足时为空）, … }；抛错算没满足（报错先换掉 key），并用 drive.start 重新
 *        启动 Mori 再试（restartReal）。每次之后截图 <name>-<attempt>（shotReal）。每次没满足的原因写进整次运行的说明；
 *        仍没满足时 ids 各记一条 "<编号> real <name>: the drive's precondition holds within 3 attempts" 的失败。
 * @param drive { name, ids, start? }（可以直接传步骤）
 * @return { take（最后一次的结果）, notes（每次没满足的原因）, ok（最后一次满足了前提） }
 */
export async function withAttempts(ctx, drive, once) {
  const notes = [];
  let take = {};
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let threw = false;
    try {
      take = (await once(attempt, take)) ?? {};
    } catch (error) {
      threw = true;
      take = { ...take, unmet: `flow: ${errorText(error, 300)}` };
    }
    await shotReal(ctx, `${drive.name}-${attempt}`);
    if (!take.unmet) break;
    notes.push(`attempt ${attempt}: ${take.unmet}`);
    if (threw && attempt < ATTEMPTS) await restartReal(ctx, drive.start ?? {});
  }
  if (notes.length) ctx.note(`${drive.name}: ${notes.join('; ')}`);
  if (take.unmet) {
    for (const id of drive.ids) {
      ctx.record(`${id} real ${drive.name}: the drive's precondition holds within ${ATTEMPTS} attempts`, false,
        notes.join('; '));
    }
  }
  return { take, notes, ok: !take.unmet };
}

// ---------- 步骤、收尾与 key 的核对 ----------

/**
 * @brief 这个步骤里的页面错误记一条检查（每个编号一条，检查名以编号开头，§19.2）；记录代理在这个步骤里的上游出错
 *        （网络，不是程序保证的事）写进这条的 note 与整次运行的说明，不算失败。
 * @param from { page, proxy }：步骤开始时两个列表的长度
 */
function stepPageCheck(ctx, step, from) {
  const errors = ctx.pageErrors.slice(from.page);
  const proxy = (ctx.proxy?.errors ?? []).slice(from.proxy);
  if (proxy.length) {
    ctx.note(`step ${step.name}: the recording proxy saw ${proxy.length} upstream error(s): `
      + `${proxy.slice(0, 3).join(' | ')}`);
  }
  for (const id of step.ids) {
    ctx.record(`${id} real ${step.name}: the page reported no errors during the step`, errors.length === 0,
      errors.length ? errors.slice(0, 3) : '', proxy.length ? { proxyErrors: proxy.slice(0, 3) } : '');
  }
}

/**
 * @brief 跑一个步骤：按它的 start 确保 Mori 开着（ensureReal），再跑 run，最多 timeoutMs（默认 STEP_MS；第一次启动另加
 *        PROBE_MS）。出错或超时时它的每个编号记一条 "<编号> real <名字>: the step ran to the end" 的失败（报错先换掉
 *        key）、截图、关掉 Mori（下一个步骤从新启动的 Mori 开始）；超时的步骤再等它停下最多 SETTLE_MS。最后记这个
 *        步骤的页面检查（stepPageCheck）。
 * @return 超时的步骤在 Mori 关掉之后仍没停下为 true（之后的步骤不再跑）
 */
async function runOne(ctx, step) {
  log(`step ${step.name} (${step.ids.join(', ')})`);
  const from = { page: ctx.pageErrors.length, proxy: ctx.proxy?.errors.length ?? 0 };
  const limit = (step.timeoutMs ?? STEP_MS) + (ctx.started === 0 ? PROBE_MS : 0);
  const run = ensureReal(ctx, step.start ?? {}).then(() => step.run(ctx)).then(() => null,
    (error) => error ?? new Error(`step ${step.name} failed`));
  const outcome = await within(run, limit, TIMED_OUT);
  let stuck = false;
  if (outcome !== null) {
    const error = outcome === TIMED_OUT ? new Error(`step ${step.name} did not finish within ${limit / 60000} min`)
      : outcome;
    for (const id of step.ids) ctx.record(`${id} real ${step.name}: the step ran to the end`, false, errorText(error));
    await shotReal(ctx, `${step.name}-error`);
    await stopReal(ctx).catch((closing) => log(`closing Mori after ${step.name}: ${errorText(closing, 300)}`));
    stuck = outcome === TIMED_OUT && (await within(run, SETTLE_MS, TIMED_OUT)) === TIMED_OUT;
  }
  stepPageCheck(ctx, step, from);
  return stuck;
}

/**
 * @brief 依次跑选中的步骤（selected、runOne）。某个超时的步骤停不下时，之后的步骤的每个编号记一条没跑的失败，
 *        ctx.stuck 置真（finishReal 写完结果后结束进程）。
 */
async function runSteps(ctx, steps) {
  const chosen = steps.filter((item) => selected(ctx, item));
  for (const [index, step] of chosen.entries()) {
    if (!(await runOne(ctx, step))) continue;
    ctx.stuck = true;
    for (const rest of chosen.slice(index + 1)) {
      for (const id of rest.ids) {
        ctx.record(`${id} real ${rest.name}: the step ran to the end`, false, `not run: step ${step.name} was still `
          + `running ${SETTLE_MS / 1000} s after its time limit and Mori was closed`);
      }
    }
    return;
  }
}

/** @brief key 的明文出现在 Mori 的文件与输出之外的地方（leakCheck 用）：fixture、发给模型的请求、窗口、结果、换掉过的输出。 */
function leakSources(ctx) {
  const files = ctx.written.filter((file) => existsSync(file) && leaked(readFileSync(file, 'utf8')));
  const bodies = leaked((ctx.proxy?.captures ?? []).map((item) => item.body))
    ? ['a request body Mori sent to a model through the recording proxy'] : [];
  const hits = [...new Set(redactHits)].map((where) => `a key reached this run's output before it was replaced `
    + `by *** (${where})`);
  return [...files, ...bodies, ...ctx.shownKeys.map((label) => `Mori's window text ${label}`),
    ...(leaked(ctx.out.data) ? ['the results of this run'] : []), ...hits];
}

/**
 * @brief 知道 key 时（key 方式，或环境里有别的 key）的最后一条检查：这些 key 不以明文出现在 Mori 窗口的文字里（每次
 *        截图之前与关掉 Mori 之前查，windowClean），不在 Mori 的输出（ctx.appLog）里，不在 Mori 经记录代理发给模型的
 *        请求里，不在这次的结果与写出的 fixture 里（包括换成 *** 之前，redactHits），也不在这次用过的数据目录、它们的
 *        快照目录与临时项目的任何文件里（Mori 加密保存的 credentials.json 之外，md-real-helpers.mjs findSecrets：
 *        UTF-8 与 UTF-16LE）。在删掉 credentials.json 之后调用。不查 --repo 给的仓库（负责人的仓库，不是这次建的）。
 */
export function leakCheck(ctx) {
  const dirs = [...ctx.dataDirs, ...ctx.dataDirs.map(snapshotsDirFor), ...ctx.projects.map((item) => item.root)];
  const report = findSecrets(dirs, ctx.appLog.map((item) => item.line).join('\n'), secrets);
  const found = [...report.found, ...leakSources(ctx)];
  const which = ctx.keyMode ? 'typed into Mori or removed from the environment at start'
    : 'removed from the environment at start';
  ctx.record(`${SETUP_ID} real: none of the API keys ${which} appears in plain text in Mori's window text (checked `
    + 'before every screenshot and before Mori closed), in Mori\'s output, in the requests Mori sent to the models, '
    + `in this run's results and fixtures (${ctx.written.length}) or in any file of the data dirs, snapshot dirs and `
    + `temp projects this run used (${dirs.length}), outside the encrypted credentials.json`,
  found.length === 0 && report.unreadable.length === 0 && report.files > 0,
  { ...report, found, unreadWindows: ctx.unreadWindows });
}

/** @brief 把 Mori 的输出写成 test-results/fs-real(-packaged)/app.log（先换掉 key；key 出现过由 leakCheck 报出）。 */
function writeAppLog(ctx) {
  try {
    mkdirSync(ctx.args.shots, { recursive: true });
    writeFileSync(join(ctx.args.shots, 'app.log'), `${scrub(ctx.appLog.map((item) => item.line).join('\n'))}\n`);
  } catch (error) {
    console.error(`[fs-real] could not write app.log: ${errorText(error, 300)}`);
  }
}

/**
 * @brief 收尾（不管前面成功与否都做）：关掉 Mori 与记录代理、删掉这次用过的数据目录里的 credentials.json、写 app.log、
 *        知道 key 时最后一条检查（leakCheck）、写结果文件。有停不下的步骤（ctx.stuck）时 5 秒后结束进程。
 * @return 退出码：全部通过为 0，否则 1
 */
export async function finishReal(ctx) {
  await stopReal(ctx).catch((error) => console.error(`[fs-real] closing Mori: ${errorText(error)}`));
  await stopRealProxy(ctx.proxy);
  dropCredentials(ctx);
  writeAppLog(ctx);
  if (secrets.length) leakCheck(ctx);
  const code = ctx.out.write() ? 0 : 1;
  log(`results in test-results/${ctx.args.resultFile}; screenshots and app.log in ${ctx.args.shots}; data in `
    + `${ctx.dataDirs.join(', ') || 'none'} (credentials.json removed); projects in `
    + `${ctx.projects.map((item) => item.root).join(', ') || 'none'}`);
  if (ctx.stuck) {
    log('a step did not stop after its time limit; exiting in 5 s');
    setTimeout(() => process.exit(code), 5000).unref();
  }
  return code;
}

/**
 * @brief 整个套件：参数不合格时打印用法、不启动、不写结果（返回 1）；否则准备（prepareReal），依次跑选中的步骤
 *        （准备不合格时每个选中的编号记一条 "<编号> real setup ran to the end" 的失败），最后收尾（finishReal）。
 * @param steps [{ name, ids, run: async (ctx) => void, start?（ensureReal 的选项）, timeoutMs? }]；默认为
 *        createRealContext 给的
 * @return 退出码
 */
export async function runReal(ctx, steps = ctx.steps) {
  if (ctx.problem) {
    printUsage(ctx);
    return 1;
  }
  ctx.stepIds = [...new Set(steps.filter((step) => selected(ctx, step)).flatMap((step) => step.ids))];
  try {
    if (await prepareReal(ctx)) {
      await runSteps(ctx, steps);
    } else {
      for (const id of ctx.stepIds) {
        ctx.record(`${id} real setup ran to the end`, false, `see the ${SETUP_ID} real setup checks`);
      }
    }
  } catch (error) {
    ctx.record(`${SETUP_ID} real: the run's flow`, false, errorText(error));
  }
  return finishReal(ctx);
}

/**
 * @brief 上下文工厂：解析命令行、做跑之前的检查（startProblem，结果在 ctx.problem），装进程级的报错处理，打印从环境里
 *        删掉的别的 key 的变量名。不启动 Mori、不写文件。key 不在 ctx 里。
 * @param opts { steps：[{ name, ids, run, start?, timeoutMs? }]，fs-real.mjs 的全部步骤（--only 按它们的名字与编号认） }
 * @return ctx：
 *   args（realArgs）、keyMode、problem、steps、stepIds（这次验收的编号，runReal 填）；
 *   record(name, ok, detail?, note?)、note(text)、out（结果收集器，out.data 为结果）、redact、leaked、briefSafe、
 *   errorText、log；
 *   repo（--repo，FS-21）、sourceDir（--source 的目录，key 方式下为建出的目录；FS-55 读它的 sessions/）、found
 *   （{ first, second }：DeepSeek 与 GLM 的提供商，baseUrl 为真实地址）、refs（{ first, second }：<provider>/<model>）、
 *   routes（提供商 id → 真实地址）、proxy 与 ep（{ proxy }：记录代理）；
 *   与 fs-helpers.mjs 同形的 app、page、pageErrors、appLog、userData（复制出的数据目录）、snapshots、env、exePath、
 *   projectTabs；awayMs、awayTimeout（这次启动的 When you’re away）；
 *   started（startReal 的次数）、recFrom（recBegin 时的检查数；没在录时 null）、stuck、dataDirs、projects
 *   （[{ root, project }]）、allowed、written（写出的 fixture）、shownKeys、unreadWindows。
 */
export function createRealContext({ steps = [] } = {}) {
  guardProcess();
  const args = realArgs();
  const out = createResults(args);
  const checked = startProblem(args, steps);
  const ctx = {
    args, keyMode: args.keyMode, problem: checked.problem ?? null, steps, stepIds: [],
    out, record: out.record, note: out.note, redact, leaked, briefSafe, errorText, log,
    repo: args.repo, sourceDir: args.source, found: checked.found ?? null, refs: null, routes: {}, proxy: null,
    ep: null, app: null, page: null, pageErrors: [], appLog: [], env: {}, exePath: args.exePath, projectTabs: {},
    userData: null, snapshots: null, awayMs: null, awayTimeout: 'never', startedWith: null, started: 0,
    recFrom: null, stuck: false, dataDirs: [], projects: [], written: [], shownKeys: [], unreadWindows: [],
  };
  live = ctx;
  if (otherKeys.names.length) log(`removed from the environment before Mori starts: ${otherKeys.names.join(', ')}`);
  return ctx;
}
