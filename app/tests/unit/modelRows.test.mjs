// 设置 → Models 的模型行（docs/v1/screens/models-settings.md "Models 行"，2026-10-26 WP-02，负责人走查 M7）：行上的
// data-probe 与状态行（renderer 的 probeStatus.ts probeState、statusLine，ModelRows.tsx 用）。界面测试到得了的几行
// （验证中、判定失败、探针出错、验证通过、重新验证中）由 v1-models-app-session.mjs 的 probes、fingerprint 场景查；
// 这里查界面测试造不出的一行：没有档案又不在探测（探针抛错、档案没建成、探针没能开始，后台进程记了错误日志）时是
// "Couldn’t verify"加 Verify again，不一直写 Verifying…。档案对象是手写的（synthetic），只有 statusLine、probeState 读的几项。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKernelModule } from './load.mjs';

const { probeState, statusLine } = await loadKernelModule('src/renderer/src/components/settings/probeStatus.ts');

/** @brief 一步探针的结果（synthetic）。 */
const step = (outcome, detail = null) => ({ outcome, detail });

/**
 * @brief 档案（synthetic）：status 为 ready / error / probing，tool 为 tool_calling.state；
 *        failed 时第 3 步不通过并带 detail。
 */
function profile(status, tool, error = null) {
  const outcome = { failed: 'fail', verified: 'pass' }[tool] ?? 'error';
  const call = step(outcome, outcome === 'fail' ? 'no tool call in the reply' : null);
  return { status, error, tool_calling: { state: tool, call, result: step(outcome === 'pass' ? 'pass' : 'not_run') } };
}

test('MP-10 Models row: no profile and no probe running is the error line "Couldn’t verify" (with Verify again), '
  + 'not Verifying…', () => {
    assert.equal(probeState(null, false), 'unverified');
    assert.deepEqual(statusLine(null, false), { state: 'error', text: 'Couldn’t verify' });
  });

test('MP-10 Models row: no profile while its probe runs shows "Verifying…" (data-probe verifying)', () => {
  assert.equal(probeState(null, true), 'verifying');
  assert.deepEqual(statusLine(null, true), { state: 'verifying', text: 'Verifying…' });
});

test('MP-10 Models row: the no-profile line matches a probe error without its raw text', () => {
  const errored = profile('error', 'unverified', 'Connection error.');
  assert.equal(probeState(errored, false), 'unverified');
  assert.deepEqual(statusLine(errored, false), { state: 'error', text: 'Couldn’t verify: Connection error.' });
  assert.deepEqual(statusLine(null, false), { state: 'error', text: 'Couldn’t verify' });
});

test('MP-10 Models row: a verified model has no status line, also while re-verifying; a failed one names the step',
  () => {
    const verified = profile('ready', 'verified');
    assert.equal(statusLine(verified, false), null);
    assert.equal(statusLine(verified, true), null);
    assert.equal(probeState(verified, true), 'reverifying');
    const failed = profile('ready', 'failed');
    assert.deepEqual(statusLine(failed, false),
      { state: 'failed', text: 'Tool calling failed verification: no tool call in the reply' });
  });

// 2026-10-26 补（WP-02 的覆盖审查）：状态行在没有说明时的两种写法（docs/v1/defaults.md“模型行的状态行没有说明时”，临时默认值）
test('MP-10 Models row: a failed verification whose failing step has no detail reads "Tool calling failed '
  + 'verification" without a colon; an unverified profile without an error reads "Couldn’t verify"', () => {
  const failed = { status: 'ready', error: null,
    tool_calling: { state: 'failed', call: step('fail', null), result: step('not_run') } };
  assert.equal(probeState(failed, false), 'failed');
  assert.deepEqual(statusLine(failed, false), { state: 'failed', text: 'Tool calling failed verification' });
  const silent = profile('error', 'unverified', null);
  assert.equal(probeState(silent, false), 'unverified');
  assert.deepEqual(statusLine(silent, false), { state: 'error', text: 'Couldn’t verify' });
});
