// away.test.mjs、ask.test.mjs、team-ask.test.mjs 共用的打包入口（awayKit.mjs 的 freshKernel 用 esbuild 打包成一个文件，
// 选项同 tests/unit/load.mjs）：无人应答模块 away.ts 只有一份全局状态，批准（approval.ts）、扩展询问（extensionUi.ts）、
// 提问（askQuestion.ts）、Team（team.ts）与实例的批准接线（instances.ts）都向它登记；分开打包的话每个模块各有一份
// away.ts，登记与计时就对不上。所以放进同一个打包结果里，每次重新导入得到一份全新的状态。
// 文件名不以 .test.mjs 结尾，node --test 不单独运行它。

export * as away from '../../../src/kernel/away.ts';
export * as approval from '../../../src/kernel/approval.ts';
export * as extensionUi from '../../../src/kernel/extensionUi.ts';
export * as ask from '../../../src/kernel/askQuestion.ts';
export * as team from '../../../src/kernel/team.ts';
export * as instances from '../../../src/kernel/instances.ts';
export * as resources from '../../../src/kernel/resources.ts';
export * as board from '../../../src/kernel/board.ts';
export * as boardText from '../../../src/kernel/boardText.ts';
export * as handoffForm from '../../../src/kernel/handoffForm.ts';
export * as limits from '../../../src/kernel/limits.ts';
export * as shared from '../../../src/shared/workspace.ts';
