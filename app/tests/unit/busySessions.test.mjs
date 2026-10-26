// 正在生成的会话数（docs/v0/screens/window.md"正在生成的会话"，WP-20）的单元测试：界面的 sessionRows.ts busyCount
// （与侧栏 isBusy 同一规则："Running"、"Needs approval"、"Needs input"，含界面重新加载后还没点开的 live 会话，打开着的
// 不再按列表重复算）、state/busySessions.ts reportBusySessions（启动时报一次，之后数变了才报）、actions.ts
// handleKernelExit 之后数变成 0。
// 这几个模块打成一个包（同一份界面状态 store）。页面的全局对象（window、localStorage、window.mori）是替身（synthetic）：
// window.mori.setBusySessions 只记下报告的数，其余方法什么都不做；会话与对话流都是测试手写的（synthetic）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 界面报告给主进程的数，按顺序 */
const reported = [];

/**
 * @brief 页面全局对象的替身（synthetic）：window 就是 globalThis，localStorage 存在内存里，
 *        window.mori 只记 setBusySessions（其余方法返回什么都不做的取消订阅）。
 */
function installPageGlobals() {
  const store = new Map();
  const localStorage = { getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  const mori = new Proxy({}, { get: (_target, name) => (name === 'setBusySessions'
    ? (count) => reported.push(count) : () => () => {}) });
  for (const [name, value] of Object.entries({ window: globalThis, localStorage, mori })) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
}

/** @brief 把要测的界面模块打成一个包再导入（一份 store）；打包结果按进程命名，导入后删掉（同 load.mjs）。 */
async function loadRenderer() {
  const outDir = join(appRoot, 'test-results', 'unit-bundles');
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `renderer_busySessions.${process.pid}.mjs`);
  const contents = ["export { busyCount } from './src/renderer/src/components/sessionRows';",
    "export { reportBusySessions } from './src/renderer/src/state/busySessions';",
    "export { newTab, useApp } from './src/renderer/src/state/store';",
    "export { handleKernelExit } from './src/renderer/src/state/actions';"].join('\n');
  await build({ stdin: { contents, resolveDir: appRoot, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node',
    target: 'node22', packages: 'external', outfile, logLevel: 'silent' });
  try {
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    rmSync(outfile, { force: true });
  }
}

installPageGlobals();
const R = await loadRenderer();

/** 后台进程里还开着的会话的状态，全部为否（synthetic） */
const IDLE_LIVE = { running: false, approval: false, question: false, teamBusy: false, teamApproval: false };

/** @brief 打开着的会话（synthetic）：fields 覆盖会话的字段，transcript 覆盖对话流的字段。 */
function tab(fields = {}, transcript = {}) {
  const base = R.newTab('C:\\work\\proj', { phase: 'ready', ...fields });
  return { ...base, transcript: { ...base.transcript, ...transcript } };
}

/** @brief 会话列表里的一个会话（synthetic）；live 为后台进程里的状态，null 表示没开着。 */
function saved(file, live) {
  return { sessionFile: file, sessionId: file, cwd: 'C:\\work\\proj', name: null, firstMessage: 'hello', modified: 1,
    live: live === null ? null : { ...IDLE_LIVE, ...live } };
}

test('WP-20 busy count: an open session counts while running, sending, waiting for you, or its agents run', () => {
  const busy = [{}, { running: true }, { sending: true }, { approvals: [{ id: 'a' }] },
    { teamApprovals: [{ id: 'b' }] }, { questions: [{ id: 'q' }] }];
  const counts = busy.map((transcript) => R.busyCount([tab({}, transcript)], []));
  assert.deepEqual(counts, [0, 1, 1, 1, 1, 1]);
  const background = tab({ team: { ...tab().team, background: true } });
  assert.equal(R.busyCount([background], []), 1);
  assert.equal(R.busyCount([tab({ phase: 'failed' }), tab({ unseen: true }), tab({ interrupted: true })], []), 0);
  assert.equal(R.busyCount([tab({}, { running: true }), tab({}, { questions: [{ id: 'q' }] }), tab()], []), 2);
});

test('WP-20 busy count: a session not opened since a reload counts by its live status', () => {
  const live = [{ running: true }, { approval: true }, { question: true }, { teamBusy: true }, { teamApproval: true }];
  const counts = live.map((item, index) => R.busyCount([], [saved(`C:\\s\\${index}.jsonl`, item)]));
  assert.deepEqual(counts, [1, 1, 1, 1, 1]);
  assert.equal(R.busyCount([], [saved('C:\\s\\idle.jsonl', {}), saved('C:\\s\\closed.jsonl', null)]), 0);
});

test('WP-20 busy count: a session both open and in the list counts once, by its open state', () => {
  const file = 'C:\\s\\both.jsonl';
  const list = [saved(file, { running: true })];
  assert.equal(R.busyCount([tab({ sessionFile: file })], list), 0);
  assert.equal(R.busyCount([tab({ sessionFile: file }, { running: true })], list), 1);
  assert.equal(R.busyCount([tab({ sessionFile: 'C:\\s\\other.jsonl' })], list), 1);
});

test('WP-20 the count goes to the main process once at start, then only when it changes', () => {
  R.useApp.setState({ tabs: [], saved: { status: 'ready', sessions: [], error: null } });
  reported.length = 0;
  R.reportBusySessions();
  assert.deepEqual(reported, [0]);
  R.useApp.setState({ activeKey: 'none' });
  const running = tab({}, { running: true });
  R.useApp.setState({ tabs: [running] });
  R.useApp.setState({ tabs: [{ ...running, draft: 'typing' }] });
  R.useApp.setState({ tabs: [running, tab({}, { approvals: [{ id: 'a' }] })] });
  R.useApp.setState({ tabs: [] });
  assert.deepEqual(reported, [0, 1, 2, 0]);
});

test('WP-20 after the background process exits the count drops to 0 and is reported', () => {
  const tabs = [tab({}, { running: true }), tab({}, { approvals: [{ id: 'a' }] }),
    tab({}, { questions: [{ id: 'q' }] })];
  R.useApp.setState({ kernel: 'ready', tabs,
    saved: { status: 'ready', sessions: [saved('C:\\s\\live.jsonl', { running: true })], error: null } });
  assert.equal(reported.at(-1), 4);
  R.handleKernelExit();
  const state = R.useApp.getState();
  assert.equal(R.busyCount(state.tabs, state.saved.sessions), 0);
  assert.equal(reported.at(-1), 0);
});
