// 加载 pi，并持有整个后台进程共用的 ModelRuntime。
// 主进程已在环境变量里设好 PI_OFFLINE、PI_TELEMETRY 和 PI_CODING_AGENT_DIR，pi 在第一次用到时才加载。
// 运行时不读 models.json（docs/specs/model-providers.md §4.4 第 1 步）：提供商与模型由模型层编译进来（modelCompile.ts）。
// API key 不交给 pi：pi 里只有一个不保密的占位 key，真正的 key 在模型池的内存里，由它在发请求时写进认证头（§4.4、§8.4）。

import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type Pi = typeof import('@earendil-works/pi-coding-agent');

let piModule: Promise<Pi> | undefined;
let runtime: Promise<ModelRuntime> | undefined;
let markReady: () => void = () => {};
const runtimeReady = new Promise<void>((resolve) => {
  markReady = resolve;
});

/**
 * @brief 动态加载 pi（pi 只提供 ESM，后台进程入口是 CJS）。加载前去掉 PI_PACKAGE_DIR：pi 会按它到别处找自己的包目录，
 *        MCP 共享连接也按这个目录载入 pi 的内部文件（mcpShare.ts）；后台进程只用 Mori 自带的 pi。Windows 上环境变量名
 *        不分大小写，从 Git Bash 启动时还可能同时带着几种写法，所以每种写法都去掉；后台进程起的命令和 MCP 服务也就不再继承它。
 */
export function loadPi(): Promise<Pi> {
  if (!piModule) {
    for (const name of Object.keys(process.env)) {
      if (name.toUpperCase() === 'PI_PACKAGE_DIR') delete process.env[name];
    }
    piModule = import('@earendil-works/pi-coding-agent');
  }
  return piModule;
}

/**
 * @brief 创建（只创建一次）共用的 ModelRuntime，不等模型层编译：modelsPath 为 null（不读 models.json），
 *        创建时不刷新（§4.4 第 1 步）。只给模型层（modelLayer.ts）用；别处用 getRuntime。
 */
export function createRuntime(): Promise<ModelRuntime> {
  runtime ??= loadPi().then((pi) => pi.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false }));
  return runtime;
}

/** @brief 模型层启动完成（配置已编译进运行时，或确定没有可编译的配置）后调用一次，放行 getRuntime。 */
export function markRuntimeReady(): void {
  markReady();
}

/** @brief 整个后台进程共用一个 ModelRuntime；等模型层把启动时的配置编译进去之后再交出去。 */
export async function getRuntime(): Promise<ModelRuntime> {
  const rt = await createRuntime();
  await runtimeReady;
  return rt;
}

/** @brief 用户级设置（`<agentDir>/settings.json`）：思考强度、按模型的新会话思考强度等。 */
export async function globalSettings() {
  const pi = await loadPi();
  return pi.SettingsManager.create(pi.getAgentDir(), pi.getAgentDir());
}
