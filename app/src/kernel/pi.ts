// 加载 pi，并持有整个后台进程共用的 ModelRuntime。
// 主进程已在环境变量里设好 PI_OFFLINE、PI_TELEMETRY 和 PI_CODING_AGENT_DIR，pi 在第一次用到时才加载。
// API key 不经环境变量，也不写进 pi 的文件：启动时主进程解密后送来，用 pi 的 runtime API key 放在内存里。

import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type Pi = typeof import('@earendil-works/pi-coding-agent');

let piModule: Promise<Pi> | undefined;
let runtime: Promise<ModelRuntime> | undefined;
let markKeysApplied: () => void = () => {};
const keysApplied = new Promise<void>((resolve) => {
  markKeysApplied = resolve;
});

/** @brief 动态加载 pi（pi 只提供 ESM，后台进程入口是 CJS）。 */
export function loadPi(): Promise<Pi> {
  piModule ??= import('@earendil-works/pi-coding-agent');
  return piModule;
}

/** @brief 创建唯一的 ModelRuntime（不等 key）。 */
function createRuntime(): Promise<ModelRuntime> {
  runtime ??= loadPi().then((pi) => pi.ModelRuntime.create({ refreshOnCreate: false }));
  return runtime;
}

/** @brief 整个后台进程共用一个 ModelRuntime；等启动时的 key 放好后再交出去。保存连接后用 refresh() 重读 models.json。 */
export async function getRuntime(): Promise<ModelRuntime> {
  const rt = await createRuntime();
  await keysApplied;
  return rt;
}

/** @brief 把主进程送来的 key 交给 pi（只在内存里）；某一项失败时记录错误并继续。 */
export async function applyStoredKeys(keys: Record<string, string>): Promise<void> {
  const rt = await createRuntime();
  for (const [providerId, key] of Object.entries(keys)) {
    try {
      await rt.setRuntimeApiKey(providerId, key);
    } catch (error) {
      console.error(`[kernel] cannot apply the stored key for ${providerId}: ${(error as Error).message}`);
    }
  }
  markKeysApplied();
}

/** @brief 用户级设置（`<agentDir>/settings.json`），读写默认模型。 */
export async function globalSettings() {
  const pi = await loadPi();
  return pi.SettingsManager.create(pi.getAgentDir(), pi.getAgentDir());
}
