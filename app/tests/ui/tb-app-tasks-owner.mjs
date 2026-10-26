// 平行 Agent 与 TaskBoard 的 App 套件：右栏的 Background tasks 读负责人的真实数据（docs/specs/parallel-agents-taskboard.md
// §17.2 TB-88）。负责人 2026-10-26 在 Har-GUI 的那次会话（6 个 task，全由基座做；T2、T5、T6 把完整清单只留在 task 的消息里）：
// 把那条用户会话的文件与它的 teams/<id>（board.json、实例会话）复制到临时数据目录，打开这条会话（不发消息），核对
// Finished 里是 T6–T1、全是 Done、没有 Running；T2（3 条）、T5（1 条）、T6（2 条）的消息全文都在 task 的视图里（T6 的两条
// 含表格）；T1–T6 与结案会话都能打开，记下 T4 的会话（约 1 MB）打开并显示完的用时。
// 只复制这两样：不读、不复制数据目录里的 credentials.json、pi/auth.json；数据不进仓库，只能在这台机器上跑。
// 用法（在 app/ 下，先 node tests/ui/tb-build.mjs tasks）：
//   MORI_APP_DIR=.tb-runs/tasks node tests/ui/tb-app-tasks-owner.mjs [--source <负责人的数据目录>] [--session <会话 id>]
// --source 默认是这台机器上 Mori 的数据目录 %APPDATA%\Mori（npm run test:taskboard 这样跑）；那里没有这条会话时失败。
// 结果写到 test-results/tb-app-tasks-owner.json（计入 App 层，§17.3），截图在 test-results/tb-app-tasks-owner/。
// 端口（§17.3 的 4950–4959）：合成端点 4952、记录代理 4953（模型配置指向它；这一步不应有任何请求）。

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  brief, closeTbApp, paneSel, poll, seedTeamUserData, shot, startTbApp, startTbEndpoint, stopTbEndpoint, suiteArgs,
  tbModel, tbProvider, tbRecorder, tempUserData,
} from './tb-helpers.mjs';
import {
  bgCards, clickBack, clickCard, openTranscript, taskViewOf, waitTaskView, waitTranscript,
} from './tb-tasks-helpers.mjs';

const args = suiteArgs('tasks-owner');
const { record, finish } = tbRecorder(args);

/** 负责人那次会话（2026-10-26 走查 M14 的证据） */
const DEFAULT_SESSION = '01a175e9-c40e-73c2-b2f1-d6d1afa725d6';
/** 端口：合成端点与记录代理（§17.3） */
const PORT = 4952;
const PROXY = 4953;

/** @brief 命令行参数 --<name> <value>。 */
function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

/**
 * @brief 在负责人的数据目录里找这条用户会话的文件（pi/sessions/<项目>/<时刻>_<id>.jsonl）。
 * @return { dir（项目目录名）, file（文件名） }；没有时为 null
 */
function findSession(source, id) {
  const root = join(source, 'pi', 'sessions');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const file = readdirSync(join(root, dir)).find((name) => name.endsWith(`_${id}.jsonl`));
    if (file) return { dir, file };
  }
  return null;
}

/** @brief 测试准备：只复制这条会话的文件与 teams/<id>，写一个本机提供商（synthetic），启动 App。 */
async function setup(ctx, source, id) {
  const found = findSession(source, id);
  if (!found || !existsSync(join(source, 'teams', id, 'board.json'))) {
    throw new Error(`no session ${id} with a TaskBoard under ${source}`);
  }
  mkdirSync(join(ctx.userData, 'pi', 'sessions', found.dir), { recursive: true });
  cpSync(join(source, 'pi', 'sessions', found.dir, found.file), join(ctx.userData, 'pi', 'sessions', found.dir,
    found.file));
  cpSync(join(source, 'teams', id), join(ctx.userData, 'teams', id), { recursive: true });
  ctx.sessionFile = join(ctx.userData, 'pi', 'sessions', found.dir, found.file);
  ctx.ep = await startTbEndpoint(PORT, PROXY);
  seedTeamUserData(ctx.userData, { providers: [tbProvider('tbowner', PROXY, [tbModel('fake-coder-tbowner')])] });
  await startTbApp(ctx);
}

/** @brief 从侧栏打开这条会话（出现信任询问时不信任：只看，不运行项目的扩展），等它就绪。 */
async function openOwnerSession(ctx) {
  const row = ctx.page.locator(`.session-item[data-file=${JSON.stringify(ctx.sessionFile)}]`);
  await row.waitFor({ timeout: 30000 });
  await row.click();
  const dialog = ctx.page.getByTestId('trust-dialog');
  if (await dialog.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
    await dialog.getByRole('button', { name: 'Don’t trust', exact: true }).click();
  }
  const tab = await row.getAttribute('data-row');
  await ctx.page.locator(`.pane-slot:not([hidden]) ${paneSel(tab)}`).waitFor({ timeout: 30000 });
  return tab;
}

/** @brief Finished 里是 T6–T1、全是 Done，没有 Running（TB-88）。 */
async function listChecks(ctx, tab) {
  await ctx.page.locator(`${paneSel(tab)} [data-testid="tasks-button"]`).click({ timeout: 30000 });
  const cards = await poll(async () => {
    const list = await bgCards(ctx);
    return list.length === 6 ? list : null;
  }, 20000) ?? await bgCards(ctx);
  record('TB-88 the owner\'s Har-GUI board: Finished lists T6–T1, all Done, and there is no Running section',
    cards.map((card) => card.task).join(',') === 'T6,T5,T4,T3,T2,T1'
      && cards.every((card) => card.section === 'finished' && card.phase === 'done'
        && card.line.includes(' · Done · ')),
    brief(cards.map((card) => `${card.task}:${card.section}:${card.phase}`)));
}

/** @brief T2、T5、T6 的消息全文在 task 的视图里（T6 的两条含表格）（TB-88）。 */
async function messageChecks(ctx) {
  const counts = {};
  for (const task of ['T2', 'T5', 'T6']) {
    await clickCard(ctx, task);
    const view = await waitTaskView(ctx, task);
    counts[task] = { messages: view?.messages.length ?? -1, tables: view?.messages.filter((item) => item.table).length,
      longest: Math.max(0, ...(view?.messages ?? []).map((item) => item.text.length)) };
    await clickBack(ctx);
  }
  record('TB-88 the task views hold the full messages: T2 has 3, T5 has 1, T6 has 2 (both with tables)',
    counts.T2?.messages === 3 && counts.T5?.messages === 1 && counts.T6?.messages === 2 && counts.T6.tables === 2,
    brief(counts));
}

/** @brief T1–T6 与结案会话都能打开；记下 T4 的会话打开并显示完的用时（TB-88）。 */
async function transcriptChecks(ctx) {
  const opened = {};
  for (const task of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) {
    const start = Date.now();
    await openTranscript(ctx, `[data-testid="bg-task"][data-task="${task}"] .bg-task-links`, null);
    const read = await waitTranscript(ctx, 'task', 60000);
    opened[task] = { ms: Date.now() - start, items: read?.items.length ?? 0, error: read?.error ?? null };
    await clickBack(ctx);
  }
  await clickCard(ctx, 'T6');
  await waitTaskView(ctx, 'T6');
  await openTranscript(ctx, '[data-testid="bg-task-view"] .bg-task-links', 'close');
  const close = await waitTranscript(ctx, 'close', 60000);
  await clickBack(ctx);
  const view = await taskViewOf(ctx);
  record('TB-88 the transcripts of T1–T6 and the closing session open; T4\'s (about 1 MB) renders in full '
    + `(${opened.T4?.ms ?? '?'} ms)`,
  Object.values(opened).every((item) => item.items > 0 && !item.error) && (close?.items.length ?? 0) > 0
    && view?.task === 'T6', brief({ opened, close: close?.items.length }));
}

const ctx = { userData: tempUserData('mori-tb-tasks-owner-'), exePath: args.exePath, pageErrors: [] };
const source = arg('source') ?? (process.env.APPDATA ? join(process.env.APPDATA, 'Mori') : null);
try {
  if (!source) throw new Error('Usage: node tests/ui/tb-app-tasks-owner.mjs --source <data dir> [--session <id>]');
  await setup(ctx, source, arg('session') ?? DEFAULT_SESSION);
  const tab = await openOwnerSession(ctx);
  for (const step of [listChecks, messageChecks, transcriptChecks]) {
    try {
      await step(ctx, tab);
    } catch (error) {
      record(`${step.name}: tasks-owner`, false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
      await shot(ctx, args, `${step.name}-error`);
    }
  }
  record('TB-88 reading the owner\'s data sent no model request', (ctx.ep?.logs.length ?? 0) === 0,
    brief(ctx.ep?.logs.length));
} catch (error) {
  record('TB-88 the owner\'s data could be opened', false, String(error?.message ?? error));
} finally {
  record('page has no errors', ctx.pageErrors.length === 0, ctx.pageErrors.slice(0, 3).join(' | '));
  await closeTbApp(ctx);
  await stopTbEndpoint(ctx.ep);
}
console.log(`[tb-app-tasks-owner] data in ${ctx.userData}`);
finish();
