// 加载 pi，并持有整个后台进程共用的 ModelRuntime。
// 主进程已在环境变量里设好 PI_OFFLINE、PI_TELEMETRY 和 PI_CODING_AGENT_DIR，pi 在第一次用到时才加载。

import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type Pi = typeof import('@earendil-works/pi-coding-agent');

let piModule: Promise<Pi> | undefined;
let runtime: Promise<ModelRuntime> | undefined;

/** @brief 动态加载 pi（pi 只提供 ESM，后台进程入口是 CJS）。 */
export function loadPi(): Promise<Pi> {
  piModule ??= import('@earendil-works/pi-coding-agent');
  return piModule;
}

/** @brief 整个后台进程共用一个 ModelRuntime；保存连接后用 refresh() 重读 models.json，已打开的会话随之生效。 */
export function getRuntime(): Promise<ModelRuntime> {
  runtime ??= loadPi().then((pi) => pi.ModelRuntime.create({ refreshOnCreate: false }));
  return runtime;
}

/** @brief 用户级设置（`<agentDir>/settings.json`），读写默认模型。 */
export async function globalSettings() {
  const pi = await loadPi();
  return pi.SettingsManager.create(pi.getAgentDir(), pi.getAgentDir());
}

/** @brief pi 设置中的默认模型。 */
export async function defaultModel(): Promise<ReturnType<ModelRuntime['getModel']>> {
  const settings = await globalSettings();
  const provider = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (!provider || !modelId) return undefined;
  return (await getRuntime()).getModel(provider, modelId);
}
