// v1 模型层的整机测试（首字很慢的端点，2026-10-31 补丁）：真正的 Mori 对合成端点（tests/fake-endpoint，synthetic），覆盖
// docs/specs/model-providers.md §7.8 与 §14.2 中 MP-45（按模型学的首个内容时限）、MP-46（模型池不受 Node 自带 fetch 的
// 5 分钟空闲上限限制）在 App 层的通过条件。
// 合成端点的行为（§14.1 的 2026-10-31 补）：-slowfirst 的每个探针请求 FAKE_FIRST_TOKEN_MS（默认 125 秒）后才回响应头；
// 关键词 wait-first-NNN 让这个请求 NNN 秒后才回响应头。Mori 直连合成端点（没有转发代理，请求的状态从日志行读）。
// 场景 slowfirst（MP-45、MP-46，约 10 分钟）：fake-coder-slowfirst 是默认范围，启动时自动探测：两轮必需一段各等 125 秒
// 都等到回答（原来 120 秒就算出错），tool calling 验证通过，档案记下 firstToken.slowestMs；然后会话发一条带
// wait-first-310 的消息：合成端点 310 秒后才回响应头（超过 Node 自带 fetch 的 300 秒与原来的 120 秒），回答照常显示，
// 没有换模型的提示和错误卡。
// 用法（在 app/ 下，先 npx electron-vite build）：
//   node tests/ui/v1-models-app-ttft.mjs [--exe <Mori.exe 路径>]
// 结果写到 test-results/v1-models-app-ttft(-packaged).json，截图在 test-results/v1-models-app-ttft(-packaged)/。
// 端口：本套件独用 5140。启动前写进数据目录的 model-config.json 是 synthetic test setup（测试准备）；提供商没有 key。

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appRoot, arg, createRecorder, oneLine, sleep } from './lib.mjs';
import { paneOf } from './m3-helpers.mjs';
import { makeProject, model, provider, seedConfig, startEndpoint } from './v1-models-session-setup.mjs';
import { errorCount, openProject, profilesWhen, sendTurn, startApp, stopApp, storedProfile, switchCount, toModels,
  rowWhen, toChat } from './v1-models-rounds-helpers.mjs';

const exePath = arg('exe') ? resolve(arg('exe')) : null;
const suffix = exePath ? '-packaged' : '';
const shots = join(appRoot, `test-results/v1-models-app-ttft${suffix}`);
mkdirSync(shots, { recursive: true });
const { record, write } = createRecorder(exePath ?? 'dev build');
const shot = (page, name) => page?.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});

/** 本套件的端口 */
const PORT = 5140;
/** 探针请求晚回响应头的毫秒数（超过原来的 120 秒） */
const FIRST_TOKEN_MS = 125000;
/** 会话请求晚回响应头的秒数（超过 Node 自带 fetch 的 300 秒） */
const WAIT_FIRST_S = 310;
const REF = 'slow/fake-coder-slowfirst';
/** @brief 检查失败时的说明。 */
const brief = (value) => oneLine(JSON.stringify(value), 600);

/** @brief 场景 slowfirst。 */
async function slowFirstScenario(ctx) {
  const ep = await startEndpoint(ctx, PORT, { FAKE_FIRST_TOKEN_MS: String(FIRST_TOKEN_MS) }, { proxy: false });
  // synthetic test setup：fake-coder-slowfirst 是默认范围；启动时自动探测
  seedConfig(ctx, { providers: [provider('slow', 'Slow', ep.url, [model('fake-coder-slowfirst')])],
    normalDefault: 'slow' });
  const started = Date.now();
  await startApp(ctx, exePath);
  const profiles = await profilesWhen(ctx.page, (all) => all[REF]?.status !== 'probing' && all[REF]?.probedAt
    && all[REF].tool_calling?.state !== 'unverified', 'the essentials', 8 * 60000);
  const took = Date.now() - started;
  const stored = storedProfile(ctx, ep.url, 'fake-coder-slowfirst');
  record('MP-45 slowfirst: probe requests that answer after 125 s are waited for (the old limit was 120 s); tool '
    + 'calling is verified after two rounds', profiles[REF].tool_calling.state === 'verified'
    && took >= 2 * FIRST_TOKEN_MS, brief({ tool: profiles[REF].tool_calling, took }));
  record('MP-45 slowfirst: the profile records the slowest first token (firstToken.slowestMs at least 125000)',
    (stored?.firstToken?.slowestMs ?? 0) >= FIRST_TOKEN_MS, brief(stored?.firstToken));
  await toModels(ctx.page);
  const row = await rowWhen(ctx.page, REF, (item) => item.status === null);
  record('MP-45 slowfirst: the model row has no status line once the essentials pass', row?.status === null,
    brief(row));
  await toChat(ctx.page);
  await slowSessionStep(ctx, ep);
}

/** @brief 会话发一条 wait-first-310 的消息：310 秒后才回响应头，回答照常显示（MP-46）。 */
async function slowSessionStep(ctx, ep) {
  await openProject(ctx, makeProject(ctx, 'proj'));
  const mark = ep.log.length;
  const sentAt = Date.now();
  await sendTurn(ctx.page, `wait-first-${WAIT_FIRST_S} hello`, (WAIT_FIRST_S + 240) * 1000);
  const waited = Date.now() - sentAt;
  const lines = ep.log.slice(mark).filter((line) => !line.probe);
  const answer = await paneOf(ctx.page).getByTestId('assistant').count();
  const switched = await switchCount(ctx.page);
  const errors = await errorCount(ctx.page);
  record(`MP-46 slowfirst: a session request whose response headers come after ${WAIT_FIRST_S} s (past Node’s `
    + '300 s idle limit and the old 120 s) gets its answer, with no model switch notice and no error card',
  waited >= WAIT_FIRST_S * 1000 && lines.length > 0 && lines.every((line) => line.status === 200)
    && answer > 0 && switched === 0 && errors === 0,
  brief({ waited, statuses: lines.map((line) => line.status), answer, switched, errors }));
}

const ctx = { name: 'slowfirst', eps: [], pageErrors: [], app: null, page: null,
  userData: mkdtempSync(join(tmpdir(), 'mori-v1t-data-')), root: mkdtempSync(join(tmpdir(), 'mori-v1t-')) };
console.log(`[v1-models-app-ttft] data in ${ctx.userData}, projects in ${ctx.root}`);
try {
  await slowFirstScenario(ctx);
} catch (error) {
  record('MP-45 slowfirst: flow', false, oneLine(error?.stack ?? error, 600));
  await shot(ctx.page, 'slowfirst-error');
} finally {
  record('MP-45 slowfirst: the page reported no errors', ctx.pageErrors.length === 0,
    ctx.pageErrors.slice(0, 3).join(' | '));
  await stopApp(ctx);
  for (const ep of ctx.eps) await ep.stop().catch(() => {});
}
await sleep(200);
process.exitCode = write(`v1-models-app-ttft${suffix}.json`) ? 0 : 1;
