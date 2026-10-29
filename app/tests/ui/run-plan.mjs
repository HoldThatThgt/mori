// run.mjs 的选择规则（纯函数，单元测试见 tests/unit/run-plan.test.mjs）：负责人 2026-10-28 定的三层测试
// （AGENTS.md“测试分层”，docs/v1/test-strategy.md）里，第二层（功能做完、推送前，20 分钟）跑这个功能自己那组的套件，
// 放不下时按下面的顺序挑；第三层（发版前，3 小时）跑全部套件，结果还算数的不重跑。
// 组与组里的套件从 package.json 的脚本读（FAMILY_SCRIPTS），不另写一份列表；用时读 tests/suite-seconds.json
// （run.mjs 每跑完一个套件写回实测的秒数），没有记录的按 DEFAULT_SECONDS 估。

/** 每组是哪几条 npm 脚本；组名同 spec-coverage 的 --spec，v0 为 m0–m6 的套件 */
export const FAMILY_SCRIPTS = {
  v0: ['smoke', 'test:app', 'test:m2-app', 'test:m3-app', 'test:m4-app', 'test:m5-app', 'test:m6-app', 'test:replay',
    'test:m2-replay', 'test:m3-replay', 'test:m4-replay', 'test:m5-replay', 'test:m6-replay'],
  model: ['test:v1-models'],
  taskboard: ['test:taskboard'],
  memory: ['test:memory'],
  discovery: ['test:discovery'],
  subagent: ['test:subagent'],
  agents: ['test:agents'],
  finish: ['test:finish'],
  filesystem: ['test:filesystem'],
};
/** 脚本里出现、但不是套件的 tests/ui 脚本（汇总、对照构建由 run.mjs 另做或不做） */
const NOT_SUITES = new Set(['v1-models-existing', 'tb-build-base', 'quick', 'uninstall', 'harness-page']);
/** 第二层给套件的时间（分钟）：20 分钟减去先跑的 2 分钟快速集（docs/v1/defaults.md） */
export const PUSH_BUDGET_MINUTES = 18;
/** 没有实测用时的套件按这么多秒估（docs/v1/defaults.md） */
export const DEFAULT_SECONDS = 300;
/** 跑这个套件之前要先有的对照构建：套件 → 建它的脚本（tb-app-roles 的 TB-03 要 .tb-runs/base） */
export const SETUP_FOR = { 'tb-app-roles': 'tb-build-base' };

/**
 * @brief 各组的套件，按脚本里的顺序、组内不重复。
 * @param scripts package.json 的 scripts
 * @return Map<组名, 脚本名（不带 .mjs）[]>
 */
export function familiesOf(scripts) {
  const families = new Map();
  for (const [family, names] of Object.entries(FAMILY_SCRIPTS)) {
    const suites = [];
    for (const words of names.flatMap((name) => (scripts[name] ?? '').split('&&'))
      .map((part) => part.trim().split(/\s+/))) {
      const match = words[0] === 'node' ? /^tests\/ui\/([\w-]+)\.mjs$/.exec(words[1] ?? '') : null;
      if (match && !NOT_SUITES.has(match[1]) && !suites.includes(match[1])) suites.push(match[1]);
    }
    families.set(family, suites);
  }
  return families;
}

/** @brief 第二层里先跑的：0 测试代码改过或上次失败，1 回放（便宜、覆盖每一屏），2 其余 App 套件。 */
function rankOf(candidate) {
  if (/^stale: tests changed|^failed/.test(candidate.reason)) return 0;
  return candidate.layer === 'replay' ? 1 : 2;
}

/**
 * @brief 第二层的选择：结果还算数的不跑；其余按 rankOf、同一级里上次跑得最早的（从没跑过的最先）在前，依次放进预算，
 *        放不下的跳过、接着看后面更短的；没放进去的留给第三层。
 * @param candidates [{ name, layer, seconds, fresh, reason, at }]（按组里的顺序）
 * @param budgetSeconds 给套件的秒数
 * @return { run, fresh, deferred, seconds：run 的估计总秒数 }
 */
export function planPush(candidates, budgetSeconds) {
  const fresh = candidates.filter((candidate) => candidate.fresh);
  const ordered = candidates.filter((candidate) => !candidate.fresh).map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => rankOf(a.candidate) - rankOf(b.candidate)
      || (a.candidate.at ?? '').localeCompare(b.candidate.at ?? '') || a.index - b.index)
    .map(({ candidate }) => candidate);
  const run = [];
  const deferred = [];
  let seconds = 0;
  for (const candidate of ordered) {
    if (seconds + candidate.seconds <= budgetSeconds) {
      run.push(candidate);
      seconds += candidate.seconds;
    } else {
      deferred.push(candidate);
    }
  }
  return { run, fresh, deferred, seconds };
}

/**
 * @brief 第三层与 --suites 的选择：rerun 时全跑，否则只跑结果不算数的。
 * @return { run, fresh, deferred: [], seconds }
 */
export function planAll(candidates, rerun) {
  const run = candidates.filter((candidate) => rerun || !candidate.fresh);
  const fresh = candidates.filter((candidate) => !run.includes(candidate));
  return { run, fresh, deferred: [], seconds: run.reduce((sum, candidate) => sum + candidate.seconds, 0) };
}
